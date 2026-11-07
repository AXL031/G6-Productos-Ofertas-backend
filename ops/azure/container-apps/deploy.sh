#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly RESOURCE_GROUP='rg-g6-aca-chile'
readonly REPOSITORY='ghcr.io/taller-sw-web/g6-productos-ofertas-backend'

fail() { printf 'Despliegue Azure fallido: %s\n' "$1" >&2; exit 1; }
[[ $# == 2 ]] || fail 'uso: deploy.sh <servicio> <imagen-con-digest>'
service="$1" image="$2"
case "$service" in
  api-gateway|bulk-svc|catalog-svc|combos-svc|inventory-svc|price-audit-svc|pricing-svc|promotions-svc|taxonomy-svc) ;;
  *) fail 'servicio fuera de la allowlist de nueve aplicaciones' ;;
esac
[[ "$image" == "$REPOSITORY/$service@sha256:"* && "${image##*@sha256:}" =~ ^[0-9a-f]{64}$ ]] || fail 'imagen fuera del paquete oficial o sin digest inmutable'
app="$service"
container="$service"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

read_app() { az containerapp show --name "$app" --resource-group "$RESOURCE_GROUP" --output json; }
read_containers() { jq -e '.properties.template.containers | type == "array" and length > 0' "$1" >/dev/null; }
normalize_app() {
  jq -S -c --arg target "$container" '
    {
      configuration: .properties.configuration,
      template: (.properties.template | .containers |= map(if .name == $target then del(.image) else . end))
    }' "$1"
}
container_image() { jq -er --arg name "$container" '[.properties.template.containers[] | select(.name == $name) | .image] | if length == 1 then .[0] else error("container target ausente o duplicado") end' "$1"; }
revision_health() {
  local revision="$1" output="$2"
  az containerapp revision show --name "$app" --resource-group "$RESOURCE_GROUP" --revision "$revision" --output json > "$output"
}

before="$work/before.json"
after="$work/after.json"
revision="$work/revision.json"
read_app > "$before" || fail "no se pudo inspeccionar ACA ${app}"
read_containers "$before" || fail 'respuesta ACA sin lista de contenedores válida'
if [[ "$service" == api-gateway ]]; then
  jq -e '[.properties.template.containers[] | select(.name == "Caddy")] | length == 1' "$before" >/dev/null || fail 'Gateway no contiene exactamente un sidecar Caddy; actualización cancelada'
fi
previous_image="$(container_image "$before")" || fail 'no se encontró exactamente un contenedor de destino'
[[ "$previous_image" == "$REPOSITORY/$service@sha256:"* && "${previous_image##*@sha256:}" =~ ^[0-9a-f]{64}$ ]] || fail 'la imagen previa no es un digest oficial verificable; rollback seguro imposible'
normalize_app "$before" > "$work/before-normalized.json"

verify_revision() {
  local expected="$1" deadline_attempts="${ACA_POLL_ATTEMPTS:-30}" delay="${ACA_POLL_INTERVAL_SECONDS:-10}" attempt current latest ready revision_image health active running
  for ((attempt=1; attempt<=deadline_attempts; attempt++)); do
    read_app > "$after" || { sleep "$delay"; continue; }
    current="$(container_image "$after" 2>/dev/null || true)"
    latest="$(jq -r '.properties.latestRevisionName // empty' "$after")"
    ready="$(jq -r '.properties.latestReadyRevisionName // empty' "$after")"
    if [[ "$current" == "$expected" && -n "$latest" && "$latest" == "$ready" ]] && revision_health "$latest" "$revision"; then
      revision_image="$(container_image "$revision" 2>/dev/null || true)"
      health="$(jq -r '.properties.healthState // empty' "$revision")"
      active="$(jq -r '.properties.active // false' "$revision")"
      running="$(jq -r '.properties.runningState // empty' "$revision")"
      if [[ "$revision_image" == "$expected" && "$health" == Healthy && "$active" == true && "$running" == Running ]]; then return 0; fi
    fi
    sleep "$delay"
  done
  return 1
}

if [[ "$previous_image" == "$image" ]]; then
  printf 'Idempotencia: %s ya usa la imagen/digest solicitado; verificando revisión existente.\n' "$service"
  verify_revision "$image" || fail 'imagen ya presente, pero revisión activa no está Healthy'
else
  printf 'Actualizando solo %s/%s en %s; configuración privada y otros contenedores se verificarán sin imprimirlos.\n' "$app" "$container" "$RESOURCE_GROUP"
  if az containerapp update --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$image" --output none && \
     verify_revision "$image" && normalize_app "$after" > "$work/after-normalized.json" && \
     cmp -s "$work/before-normalized.json" "$work/after-normalized.json"; then
    printf 'Despliegue verificado: servicio=%s revision=%s image=%s health=Healthy.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image"
    exit 0
  fi

  printf 'Fallo tras actualización de %s; restaurando la imagen previa por digest.\n' "$service" >&2
  if az containerapp update --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none && \
     verify_revision "$previous_image" && normalize_app "$after" > "$work/rollback-normalized.json" && \
     cmp -s "$work/before-normalized.json" "$work/rollback-normalized.json"; then
    printf 'ROLLBACK VERIFICADO: servicio=%s revision=%s image=%s health=Healthy; configuración comparada.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image" >&2
  else
    printf 'ROLLBACK NO VERIFICADO: servicio=%s; revisar ACA manualmente antes de reintentar.\n' "$service" >&2
  fi
  exit 1
fi

normalize_app "$after" > "$work/after-normalized.json"
cmp -s "$work/before-normalized.json" "$work/after-normalized.json" || fail 'la revisión actual no conserva las propiedades/configuración de contenedores inspeccionadas'
printf 'Despliegue verificado: servicio=%s revision=%s image=%s health=Healthy.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image"
