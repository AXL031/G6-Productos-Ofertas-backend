#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'PUBLICACIÓN BLOQUEADA: %s\n' "$1" >&2
  exit 1
}

[[ $# == 3 ]] || fail 'uso: validate-publish-only-source.sh <service> <sha> <output-file>'
service="$1"
requested_sha="$2"
output_file="$3"
repository="${GITHUB_REPOSITORY:-}"
event_sha="${GITHUB_SHA:-}"
readonly authorized_repository='Taller-SW-Web/G6-Productos-Ofertas-backend'

case "$service" in
  api-gateway|catalog-svc|taxonomy-svc) ;;
  *) fail 'servicio fuera de la allowlist de publicación' ;;
esac
[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA inválido'
[[ "$event_sha" =~ ^[0-9a-f]{40}$ && "$requested_sha" == "$event_sha" ]] ||
  fail 'el SHA solicitado no coincide con el SHA del evento workflow_dispatch'
[[ "${repository,,}" == "${authorized_repository,,}" ]] ||
  fail 'GITHUB_REPOSITORY no autorizado'
[[ -n "${GH_TOKEN:-}" ]] || fail 'GITHUB_TOKEN de solo lectura no disponible'
[[ -n "$output_file" ]] || fail 'archivo de outputs requerido'

repository="$authorized_repository"
current_master="$(gh api "repos/${repository}/commits/master" --jq '.sha')" ||
  fail 'no se pudo consultar la punta de master'
[[ "$current_master" =~ ^[0-9a-f]{40}$ && "$requested_sha" == "$current_master" ]] ||
  fail 'el SHA solicitado ya no es la punta vigente de master'

ci_success="$(gh run list \
  --repo "$repository" \
  --workflow ci.yml \
  --branch master \
  --commit "$requested_sha" \
  --limit 100 \
  --json conclusion,event,headBranch,headSha \
  --jq "any(.[]; .conclusion == \"success\" and .event == \"push\" and .headBranch == \"master\" and .headSha == \"$requested_sha\")")" ||
  fail 'no se pudo verificar el workflow de CI'
[[ "$ci_success" == true ]] || fail 'no existe CI push/master exitosa para el SHA exacto'

# Values are restricted above so they cannot inject workflow output commands.
{
  printf 'sha=%s\n' "$requested_sha"
  printf 'service=%s\n' "$service"
  printf 'repository=%s\n' "$repository"
} >> "$output_file"
