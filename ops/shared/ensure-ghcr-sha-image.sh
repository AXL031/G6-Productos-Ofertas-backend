#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo 'Uso: ensure-ghcr-sha-image.sh <owner/repo> <servicio> <sha> <GITHUB_OUTPUT>' >&2
  exit 64
}

[[ $# == 4 ]] || usage
repository="${1,,}" service="$2" sha="$3" output="$4"
[[ "$repository" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || usage
[[ "$service" =~ ^[a-z][a-z0-9-]{0,31}$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || usage
[[ -n "$output" ]] || usage

image="ghcr.io/${repository}/${service}:${sha}"
source="https://github.com/${repository}"
inspect_error="$(mktemp)"
trap 'rm -f "$inspect_error"' EXIT

if docker manifest inspect "$image" >/dev/null 2>"$inspect_error"; then
  docker pull "$image" >/dev/null || { echo 'No se pudo descargar/verificar la imagen existente de GHCR.' >&2; exit 1; }
  labels="$(docker image inspect "$image" --format '{{json .Config.Labels}}')" || {
    echo 'No se pudieron leer las etiquetas OCI de la imagen existente.' >&2; exit 1;
  }
  jq -e --arg source "$source" --arg revision "$sha" --arg service "$service" \
    '((."org.opencontainers.image.source" | ascii_downcase) == ($source | ascii_downcase)) and
     ."org.opencontainers.image.revision" == $revision and
     ."org.opencontainers.image.title" == $service' <<< "$labels" >/dev/null || {
      echo 'La imagen existente no acredita repositorio, SHA y servicio; no se sobrescribe.' >&2
      exit 1
    }
  repo_digests="$(docker image inspect "$image" --format '{{json .RepoDigests}}')" || {
    echo 'No se pudieron leer los digests de la imagen existente.' >&2; exit 1;
  }
  digest="$(jq -er --arg prefix "ghcr.io/${repository}/${service}@" \
    '[.[] | select(startswith($prefix)) | capture("@(?<digest>sha256:[0-9a-f]{64})$").digest] | unique | if length == 1 then .[0] else error("digest ausente o contradictorio") end' \
    <<< "$repo_digests")" || { echo 'Digest GHCR ausente o contradictorio.' >&2; exit 1; }
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Digest GHCR inválido.' >&2; exit 1; }
  printf 'exists=true\nimage=%s\ndigest=%s\n' "$image" "$digest" >> "$output"
  echo 'CORRECTO: imagen GHCR existente verificada por identidad, SHA, servicio y digest; se reutilizará.'
  exit 0
fi

if ! grep -Eiq 'manifest unknown|no such manifest|not found|404' "$inspect_error"; then
  echo 'No se pudo comprobar con seguridad si la etiqueta GHCR existe.' >&2
  exit 1
fi
printf 'exists=false\nimage=%s\n' "$image" >> "$output"
echo 'CORRECTO: no existe imagen para este SHA; se permite una primera publicación.'
