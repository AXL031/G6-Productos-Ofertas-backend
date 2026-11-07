#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly RESOURCE_GROUP='rg-g6-aca-chile'
readonly REPOSITORY='ghcr.io/taller-sw-web/g6-productos-ofertas-backend'
fail() { printf 'Despliegue Azure fallido: %s\n' "$1" >&2; exit 1; }

mode=deploy
if [[ "${1:-}" == --restore ]]; then
  [[ $# == 5 ]] || fail 'uso: deploy.sh --restore <servicio> <digest-anterior> <digest-aplicado> <sha256-configuración>'
  mode=restore; service="$2"; previous_image="$3"; image="$4"; expected_config_hash="$5"
elif [[ "${1:-}" == --inspect ]]; then
  [[ $# == 3 ]] || fail 'uso: deploy.sh --inspect <servicio> <imagen-candidata>'
  mode=inspect; service="$2"; image="$3"
else
  [[ $# == 2 ]] || fail 'uso: deploy.sh <servicio> <imagen-con-digest>'
  service="$1"; image="$2"
fi
case "$service" in api-gateway|bulk-svc|catalog-svc|combos-svc|inventory-svc|price-audit-svc|pricing-svc|promotions-svc|taxonomy-svc) ;; *) fail 'servicio fuera de la allowlist de nueve aplicaciones' ;; esac
for candidate in "$image" "${previous_image:-$image}"; do
  [[ "$candidate" == "$REPOSITORY/$service@sha256:"* && "${candidate##*@sha256:}" =~ ^[0-9a-f]{64}$ ]] || fail 'imagen fuera del paquete oficial o sin digest inmutable'
done
[[ "$mode" != restore || "$expected_config_hash" =~ ^[0-9a-f]{64}$ ]] || fail 'hash de configuración inválido'

app="$service"; container="$service"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
before="$work/before.json"; after="$work/after.json"; revision="$work/revision.json"
read_app() { az containerapp show --name "$app" --resource-group "$RESOURCE_GROUP" --output json; }
normalize_app() {
  jq -S -c --arg target "$container" '
    {
      identity: .identity,
      location: .location,
      tags: .tags,
      kind: .kind,
      properties: (
        .properties
        | del(.latestRevisionName, .latestReadyRevisionName, .latestRevisionFqdn, .provisioningState)
        | .template |= (del(.revisionSuffix) | .containers |= map(if .name == $target then del(.image) else . end))
      )
    }' "$1"
}
container_image() { jq -er --arg name "$container" '[.properties.template.containers[] | select(.name == $name) | .image] | if length == 1 then .[0] else error("container target ausente o duplicado") end' "$1"; }
revision_health() { az containerapp revision show --name "$app" --resource-group "$RESOURCE_GROUP" --revision "$1" --output json > "$2"; }
verify_revision() {
  local expected="$1" deadline_attempts="${ACA_POLL_ATTEMPTS:-30}" delay="${ACA_POLL_INTERVAL_SECONDS:-10}" attempt current latest ready revision_image health active running replicas min_replicas provisioning
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
      replicas="$(jq -r '.properties.replicas // -1' "$revision")"
      min_replicas="$(jq -r '.properties.template.scale.minReplicas // -1' "$revision")"
      provisioning="$(jq -r '.properties.provisioningState // empty' "$revision")"
      if [[ "$revision_image" == "$expected" && "$active" == true && "$running" == Running && "$health" == Healthy ]]; then
        verified_mode=running; verified_replicas="$replicas"; verified_health="$health"
        return 0
      fi
      if [[ "$revision_image" == "$expected" && "$active" == true && "$running" == Stopped && "$replicas" == 0 && "$min_replicas" == 0 && "$provisioning" == Provisioned && ( "$health" == None || "$health" == Healthy ) ]]; then
        verified_mode=scale-to-zero; verified_replicas=0; verified_health="$health"
        return 0
      fi
    fi
    sleep "$delay"
  done
  return 1
}

if [[ "$mode" == inspect ]]; then
  read_app > "$before" || { echo 'INSPECTION_UNKNOWN: no se pudo leer ACA.'; exit 2; }
  current="$(container_image "$before" 2>/dev/null || true)"
  if [[ "$current" == "$image" ]]; then
    printf 'TARGET_ACTIVE: %s\n' "$service"
  elif [[ "$current" == "$REPOSITORY/$service@sha256:"* && "${current##*@sha256:}" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'TARGET_NOT_ACTIVE: %s current=%s\n' "$service" "$current"
  else
    printf 'INSPECTION_UNKNOWN: imagen actual ausente/no verificable para %s.\n' "$service"
    exit 2
  fi
  exit 0
fi

if [[ "$mode" == restore ]]; then
  read_app > "$before" || fail 'no se pudo inspeccionar ACA para recuperación'
  current="$(container_image "$before")" || fail 'no se pudo verificar imagen actual'
  normalize_app "$before" > "$work/current-normalized.json"
  current_hash="$(sha256sum "$work/current-normalized.json" | awk '{print $1}')"
  if [[ "$current" == "$previous_image" && "$current_hash" == "$expected_config_hash" ]]; then
    printf 'RECUPERACIÓN YA PRESENTE: servicio=%s conserva digest anterior y configuración.\n' "$service"
    exit 0
  fi
  [[ "$current" == "$image" && "$current_hash" == "$expected_config_hash" ]] || {
    printf 'RECUPERACIÓN OMITIDA: %s cambió concurrentemente (imagen/configuración); no se sobrescribe. Revisión manual requerida.\n' "$service" >&2
    exit 1
  }
  az containerapp update --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none || fail 'Azure rechazó la recuperación'
  verify_revision "$previous_image" || fail 'revisión de recuperación no Healthy'
  normalize_app "$after" > "$work/after-normalized.json"
  cmp -s "$work/current-normalized.json" "$work/after-normalized.json" || fail 'la configuración cambió durante la recuperación'
  printf 'ROLLBACK COORDINADO VERIFICADO: servicio=%s revision=%s image=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image"
  exit 0
fi

read_app > "$before" || fail "no se pudo inspeccionar ACA ${app}"
jq -e '.properties.template.containers | type == "array" and length > 0' "$before" >/dev/null || fail 'respuesta ACA sin lista de contenedores válida'
if [[ "$service" == api-gateway ]]; then
  jq -e '[.properties.template.containers[] | select(.name == "caddy")] | length == 1' "$before" >/dev/null || fail 'Gateway no contiene exactamente un sidecar caddy; actualización cancelada'
fi
previous_image="$(container_image "$before")" || fail 'no se encontró exactamente un contenedor de destino'
[[ "$previous_image" == "$REPOSITORY/$service@sha256:"* && "${previous_image##*@sha256:}" =~ ^[0-9a-f]{64}$ ]] || fail 'la imagen previa no es un digest oficial verificable; rollback seguro imposible'
normalize_app "$before" > "$work/before-normalized.json"
baseline_hash="$(sha256sum "$work/before-normalized.json" | awk '{print $1}')"
if [[ -n "${DEPLOY_RECEIPT:-}" ]]; then
  printf 'service=%s\nprevious=%s\ntarget=%s\nconfig_sha256=%s\n' "$service" "$previous_image" "$image" "$baseline_hash" > "$DEPLOY_RECEIPT"
fi

if [[ "$previous_image" == "$image" ]]; then
  printf 'Idempotencia: %s ya usa la imagen/digest solicitado; verificando revisión existente.\n' "$service"
  verify_revision "$image" || fail 'imagen ya presente, pero revisión activa no está Healthy'
  printf 'REVISIÓN VERIFICADA: servicio=%s modo=%s réplicas=%s salud=%s.\n' "$service" "$verified_mode" "$verified_replicas" "$verified_health"
else
  # Store only hashes and immutable image references; never serialize ACA secrets into artifacts.
  printf 'Actualizando solo %s/%s en %s; configuración ACA se comparará sin imprimirla.\n' "$app" "$container" "$RESOURCE_GROUP"
  if az containerapp update --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$image" --output none && \
     verify_revision "$image" && normalize_app "$after" > "$work/after-normalized.json" && \
     cmp -s "$work/before-normalized.json" "$work/after-normalized.json"; then
    printf 'Despliegue verificado: servicio=%s revision=%s image=%s modo=%s réplicas=%s salud=%s.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image" "$verified_mode" "$verified_replicas" "$verified_health"
    exit 0
  fi

  printf 'Fallo tras actualización de %s; se comprobará concurrencia antes del rollback local.\n' "$service" >&2
  read_app > "$after" || fail 'ROLLBACK NO VERIFICADO: no se pudo releer ACA; revisar manualmente'
  current="$(container_image "$after" 2>/dev/null || true)"
  normalize_app "$after" > "$work/failure-normalized.json"
  failure_hash="$(sha256sum "$work/failure-normalized.json" | awk '{print $1}')"
  if [[ "$current" != "$image" || "$failure_hash" != "$baseline_hash" ]]; then
    printf 'ROLLBACK OMITIDO: %s cambió concurrentemente; imagen_actual=%s. Revisar ACA manualmente.\n' "$service" "${current:-desconocida}" >&2
    exit 1
  fi
  if az containerapp update --name "$app" --resource-group "$RESOURCE_GROUP" --container-name "$container" --image "$previous_image" --output none && \
     verify_revision "$previous_image" && normalize_app "$after" > "$work/rollback-normalized.json" && \
     cmp -s "$work/before-normalized.json" "$work/rollback-normalized.json"; then
    printf 'ROLLBACK VERIFICADO: servicio=%s revision=%s image=%s modo=%s réplicas=%s salud=%s; configuración comparada.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$previous_image" "$verified_mode" "$verified_replicas" "$verified_health" >&2
  else
    printf 'ROLLBACK NO VERIFICADO: servicio=%s; revisar ACA manualmente antes de reintentar.\n' "$service" >&2
  fi
  exit 1
fi

normalize_app "$after" > "$work/after-normalized.json"
cmp -s "$work/before-normalized.json" "$work/after-normalized.json" || fail 'la revisión actual no conserva las propiedades/configuración persistentes inspeccionadas'
printf 'Despliegue verificado: servicio=%s revision=%s image=%s health=Healthy.\n' "$service" "$(jq -r '.properties.latestRevisionName' "$after")" "$image"
