#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../oracle/service-registry.sh
source "${SCRIPT_DIR}/service-registry.sh"

if [[ -f /etc/g6-productos-ofertas/azure.conf ]]; then
  # shellcheck disable=SC1091
  source /etc/g6-productos-ofertas/azure.conf
fi

readonly G6_DEPLOY_EXECUTOR_VERSION=5
readonly G6_SUPPORTED_SERVICE_REGISTRY_VERSION=2
readonly G6_HTTP_GENERIC_OVERLAY="/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml"
readonly G6_HTTP_INVENTORY_OVERLAY="/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml"
readonly G6_REGISTRY_PREFIX='ghcr.io/taller-sw-web/g6-productos-ofertas-backend'

fail() {
  printf 'G6 deployment: %s\n' "$1" >&2
  exit 1
}
G6_SERVICE_REGISTRY_VERSION="$(g6_service_registry_version)" || fail 'versión del registro ausente o inválida'
readonly G6_SERVICE_REGISTRY_VERSION

if [[ "${1:-}" == --version && $# == 1 && -z "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  [[ "$G6_SERVICE_REGISTRY_VERSION" == "$G6_SUPPORTED_SERVICE_REGISTRY_VERSION" ]] ||
    fail 'versiones incompatibles de ejecutor y registro'
  printf 'ejecutor=%s registro=%s\n' "$G6_DEPLOY_EXECUTOR_VERSION" "$G6_SERVICE_REGISTRY_VERSION"
  exit 0
fi
[[ $# == 0 ]] || fail 'argumentos locales no autorizados'
[[ "$G6_SERVICE_REGISTRY_VERSION" == "$G6_SUPPORTED_SERVICE_REGISTRY_VERSION" ]] ||
  fail 'versiones incompatibles de ejecutor y registro'

readonly GENERIC_DEPLOY_RE='^service-deploy (api-gateway|catalog-svc|taxonomy-svc) ([0-9a-f]{40}) (sha256:[0-9a-f]{64})$'
SERVICE_NAME=''
IMAGE_SHA=''

if [[ "${SSH_ORIGINAL_COMMAND:-}" =~ $GENERIC_DEPLOY_RE ]]; then
  SERVICE_NAME="${BASH_REMATCH[1]}"
  IMAGE_SHA="${BASH_REMATCH[2]}"
  IMAGE_DIGEST="${BASH_REMATCH[3]}"
else
  fail 'comando remoto no autorizado'
fi

g6_service_config "$SERVICE_NAME" || fail 'servicio no autorizado'
[[ "$G6_SERVICE_ENABLED" == true ]] || fail 'servicio registrado pero no habilitado para despliegue'
[[ "$IMAGE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA inválido'

readonly REGISTRY_IMAGE="${G6_REGISTRY_PREFIX}/${G6_SERVICE_IMAGE_NAME}"
readonly NEW_IMAGE="${REGISTRY_IMAGE}@${IMAGE_DIGEST}"
command -v jq >/dev/null 2>&1 || fail 'jq requerido para verificar readiness'
command -v timeout >/dev/null 2>&1 || fail 'timeout requerido para acotar verificaciones'

GHCR_USERNAME=''
GHCR_TOKEN=''
# Empty stdin supports public official images or credentials already absent.
# Credentials, when supplied, only live in the private temporary Docker config.
IFS= read -r GHCR_USERNAME || true
IFS= read -r GHCR_TOKEN || true
[[ -z "$GHCR_USERNAME" && -z "$GHCR_TOKEN" || -n "$GHCR_USERNAME" && -n "$GHCR_TOKEN" ]] || fail 'credenciales GHCR incompletas'

g6_http_member_expected_alias() {
  local requested_container="$1" service enabled project compose_unit
  local member_kind
  while IFS='|' read -r service enabled _ _ _ _ _ _ project compose_unit _ _ _; do
    [[ -n "$service" && "$service" != \#* ]] || continue
    if [[ "$enabled" == true && "g6-${service}" == "$requested_container" ]]; then
      member_kind=other
      [[ "$compose_unit" == service && "$service" != inventory-svc ]] && member_kind=generic
      printf '%s|%s|%s|%s\n' "$service" "$member_kind" "$project" "$compose_unit"
      return 0
    fi
  done < "$G6_SERVICE_REGISTRY"
  return 1
}

g6_validate_http_network() {
  local target_alias="$1" target_container="$2" contract members member aliases alias previous member_metadata expected_alias member_kind expected_project expected_compose_unit identity actual_project actual_compose_unit alias_found
  local driver scope internal attachable ingress config_only ipam_driver ipam_configs options_count
  local -A seen_aliases=()
  local -A generic_members=()

  contract="$(docker network inspect --format \
    '{{.Driver}}|{{.Scope}}|{{.Internal}}|{{.Attachable}}|{{.Ingress}}|{{.ConfigOnly}}|{{.IPAM.Driver}}|{{len .IPAM.Config}}|{{len .Options}}' \
    g6-http 2>/dev/null)" || fail 'no se pudo inspeccionar g6-http; no se descargó ni cambió el servicio'
  IFS='|' read -r driver scope internal attachable ingress config_only ipam_driver ipam_configs options_count <<< "$contract"
  [[ "$driver" == bridge && "$scope" == local && "$internal" == false &&
    "$attachable" == false && "$ingress" == false && "$config_only" == false &&
    "$ipam_driver" == default && "$ipam_configs" =~ ^[1-9][0-9]*$ && "$options_count" == 0 ]] ||
    fail 'g6-http no coincide con bridge local, no-internal y configuración IPAM predeterminada; no se descargó ni cambió el servicio'

  members="$(docker network inspect --format \
    '{{range $id, $container := .Containers}}{{$container.Name}}{{"\n"}}{{end}}' \
    g6-http 2>/dev/null)" || fail 'no se pudieron inspeccionar los miembros de g6-http; no se descargó ni cambió el servicio'
  while IFS= read -r member; do
    [[ -n "$member" ]] || continue
    member_metadata="$(g6_http_member_expected_alias "$member")" ||
      fail "g6-http contiene un miembro no habilitado: ${member}; no se descargó ni cambió el servicio"
    IFS='|' read -r expected_alias member_kind expected_project expected_compose_unit <<< "$member_metadata"
    generic_members["$member"]="$member_kind"
    identity="$(docker inspect --format \
      '{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project"}}' \
      "$member" 2>/dev/null)" || fail "no se pudo identificar el proyecto Compose de ${member}; no se descargó ni cambió el servicio"
    IFS='|' read -r actual_compose_unit actual_project <<< "$identity"
    [[ "$actual_compose_unit" == "$expected_compose_unit" && "$actual_project" == "$expected_project" ]] ||
      fail "g6-http contiene un miembro ajeno al proyecto Compose registrado: ${member}; no se descargó ni cambió el servicio"
    alias_found=false
    aliases="$(docker inspect --format \
      '{{range $name, $network := .NetworkSettings.Networks}}{{if eq $name "g6-http"}}{{range $network.Aliases}}{{.}}{{"\n"}}{{end}}{{end}}{{end}}' \
      "$member" 2>/dev/null)" || fail "no se pudieron validar aliases del miembro ${member}; no se descargó ni cambió el servicio"
    while IFS= read -r alias; do
      [[ -n "$alias" ]] || continue
      [[ "$alias" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] ||
        fail "g6-http contiene un alias no reconocido en ${member}; no se descargó ni cambió el servicio"
      [[ "$alias" != "$expected_alias" ]] || alias_found=true
      previous="${seen_aliases[$alias]:-}"
      if [[ -n "$previous" && "$previous" != "$member" ]]; then
        [[ "$alias" == service && "$member_kind" == generic && "${generic_members[$previous]:-other}" == generic ]] ||
          fail "g6-http tiene el alias ${alias} duplicado entre ${previous} y ${member}; no se descargó ni cambió el servicio"
      fi
      seen_aliases["$alias"]="$member"
      if [[ "$alias" == "$target_alias" && "$member" != "$target_container" ]]; then
        fail "el alias ${target_alias} de g6-http ya pertenece a ${member}; no se descargó ni cambió el servicio"
      fi
    done <<< "$aliases"
    [[ "$alias_found" == true ]] ||
      fail "g6-http no contiene el alias canónico ${expected_alias} para ${member}; no se descargó ni cambió el servicio"
  done <<< "$members"
}

if [[ "$SERVICE_NAME" == inventory-svc ]]; then
  readonly RUNTIME_ENV_FILE="$G6_SERVICE_ENV_FILE"
  [[ -f "$G6_SERVICE_COMPOSE_FILE" ]] || fail "no existe ${G6_SERVICE_COMPOSE_FILE}"
  [[ -r "$RUNTIME_ENV_FILE" ]] || fail "no se puede leer ${RUNTIME_ENV_FILE}"
  grep -Eq "^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*('[^']+'|\"[^\"]+\"|[^[:space:]#'\"]+)" "$RUNTIME_ENV_FILE" ||
    fail "DATABASE_URL no está definido en ${RUNTIME_ENV_FILE}"
  if [[ -e "$G6_HTTP_INVENTORY_OVERLAY" ]]; then
    [[ -f "$G6_HTTP_INVENTORY_OVERLAY" && -r "$G6_HTTP_INVENTORY_OVERLAY" ]] ||
      fail 'la configuración opcional g6-http de Inventory no es un archivo legible'
    g6_validate_http_network "$G6_SERVICE_IMAGE_NAME" "$G6_SERVICE_CONTAINER"
  fi
else
  [[ -f "$G6_SERVICE_COMPOSE_FILE" ]] || fail "no existe ${G6_SERVICE_COMPOSE_FILE}"
  [[ -f "$G6_SERVICE_ENV_FILE" && -r "$G6_SERVICE_ENV_FILE" ]] ||
    fail "no se puede leer la configuración privada ${G6_SERVICE_ENV_FILE}"
  if [[ -e "$G6_HTTP_GENERIC_OVERLAY" ]]; then
    [[ -f "$G6_HTTP_GENERIC_OVERLAY" && -r "$G6_HTTP_GENERIC_OVERLAY" ]] ||
      fail 'la configuración opcional g6-http no es un archivo legible'
    g6_validate_http_network "$G6_SERVICE_IMAGE_NAME" "$G6_SERVICE_CONTAINER"
  fi
fi

mkdir -p "$G6_SERVICE_STATE_DIR"
chmod 700 "$G6_SERVICE_STATE_DIR"
command -v flock >/dev/null 2>&1 || fail 'flock no está disponible; no se puede garantizar exclusión por servicio'
exec {SERVICE_LOCK_FD}>"${G6_SERVICE_STATE_DIR}/deploy.lock" ||
  fail 'no se pudo abrir el bloqueo del servicio'
flock -w 600 "$SERVICE_LOCK_FD" || fail 'tiempo de espera agotado para el bloqueo del servicio'
readonly ACTIVE_FILE="${G6_SERVICE_STATE_DIR}/active-image"
readonly PREVIOUS_FILE="${G6_SERVICE_STATE_DIR}/previous-image"
readonly CURRENT_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$G6_SERVICE_CONTAINER" 2>/dev/null || true)"
if [[ -n "$CURRENT_IMAGE" ]]; then
  readonly CURRENT_PREFIX="${REGISTRY_IMAGE}@sha256:"
  [[ "$CURRENT_IMAGE" == "$CURRENT_PREFIX"* ]] ||
    fail 'la imagen actual no pertenece al servicio registrado; se conserva sin cambios'
  readonly CURRENT_DIGEST="${CURRENT_IMAGE#"$CURRENT_PREFIX"}"
  [[ "$CURRENT_DIGEST" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'la imagen anterior debe estar fijada por digest oficial; se conserva sin cambios'
fi

export DOCKER_CONFIG
DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
if [[ -n "$GHCR_TOKEN" ]]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin
  unset GHCR_TOKEN
fi

compose() {
  local image="$1"
  shift
  if [[ "$SERVICE_NAME" == inventory-svc ]]; then
    local -a compose_files=(--file "$G6_SERVICE_COMPOSE_FILE")
    [[ ! -f "$G6_HTTP_INVENTORY_OVERLAY" ]] || compose_files+=(--file "$G6_HTTP_INVENTORY_OVERLAY")
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      DOCKER_CONFIG="$DOCKER_CONFIG" INVENTORY_IMAGE="$image" \
      docker compose "${compose_files[@]}" --project-name "$G6_SERVICE_COMPOSE_PROJECT" "$@" "$G6_SERVICE_COMPOSE_UNIT"
  else
    local -a compose_files=(--file "$G6_SERVICE_COMPOSE_FILE")
    [[ ! -f "$G6_HTTP_GENERIC_OVERLAY" ]] || compose_files+=(--file "$G6_HTTP_GENERIC_OVERLAY")
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      DOCKER_CONFIG="$DOCKER_CONFIG" G6_SERVICE_IMAGE="$image" \
      G6_SERVICE_PORT="$G6_SERVICE_PORT" G6_SERVICE_PORT_ENV="$G6_SERVICE_PORT_ENV" \
      G6_SERVICE_CONTAINER="$G6_SERVICE_CONTAINER" G6_SERVICE_IMAGE_NAME="$G6_SERVICE_IMAGE_NAME" \
      G6_SERVICE_ENV_FILE="$G6_SERVICE_ENV_FILE" \
      docker compose "${compose_files[@]}" --project-name "$G6_SERVICE_COMPOSE_PROJECT" "$@" "$G6_SERVICE_COMPOSE_UNIT"
  fi
}

container_matches_image_and_is_healthy() {
  local expected_image="$1"
  local actual_image health_status
  actual_image="$(timeout 2 docker inspect --format '{{.Config.Image}}' "$G6_SERVICE_CONTAINER" 2>/dev/null)" || return 1
  [[ "$actual_image" == "$expected_image" ]] || return 1
  health_status="$(timeout 2 docker inspect --format '{{.State.Health.Status}}' "$G6_SERVICE_CONTAINER" 2>/dev/null)" || return 1
  [[ "$health_status" == healthy ]]
}

service_is_healthy() {
  local expected_image="$1"
  container_matches_image_and_is_healthy "$expected_image" &&
    curl --fail --silent --max-time 2 "http://127.0.0.1:${G6_SERVICE_PORT}/health" >/dev/null || return 1
  if [[ "$SERVICE_NAME" == catalog-svc || "$SERVICE_NAME" == taxonomy-svc ]]; then
    local response
    response="$(curl --fail --silent --max-time 2 "http://127.0.0.1:${G6_SERVICE_PORT}/health/ready")" || return 1
    if [[ "$SERVICE_NAME" == catalog-svc ]]; then
      jq -e '.service == "catalog-svc" and .status == "ready"' <<< "$response" >/dev/null
    else
      jq -e '.service == "taxonomy-svc" and .status == "ready"' <<< "$response" >/dev/null
    fi
  fi
}

if [[ -n "$CURRENT_IMAGE" ]]; then
  printf '%s\n' "$CURRENT_IMAGE" > "${PREVIOUS_FILE}.tmp"
  mv "${PREVIOUS_FILE}.tmp" "$PREVIOUS_FILE"
fi

if ! compose "$NEW_IMAGE" pull; then
  fail 'pull de la nueva imagen falló; la instancia actual sigue activa'
fi
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$NEW_IMAGE" |
  grep -Fxq "$NEW_IMAGE" || fail 'el digest descargado no coincide con el aprobado; no se cambió el servicio'
# A digest alone is not a release approval. The reviewed manifest binds it to
# a source revision; official application images must carry that OCI label.
actual_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_IMAGE")"
[[ "$actual_revision" == "$IMAGE_SHA" ]] || fail 'la revisión OCI no coincide con el SHA aprobado'

if ! compose "$NEW_IMAGE" up --detach --no-deps; then
  if [[ -n "$CURRENT_IMAGE" ]] && compose "$CURRENT_IMAGE" up --detach --no-deps; then
    for attempt in {1..30}; do
      if service_is_healthy "$CURRENT_IMAGE"; then
        printf '%s\n' "$CURRENT_IMAGE" > "${ACTIVE_FILE}.tmp"
        mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"
        fail "arranque de nueva imagen falló; restaurada ${CURRENT_IMAGE}"
      fi
      sleep 2
    done
  fi
  if [[ -z "$CURRENT_IMAGE" ]]; then
    compose "$NEW_IMAGE" rm --stop --force
  fi
  fail 'arranque de la nueva imagen falló y el rollback no pudo verificarse'
fi

healthy=false
for attempt in {1..30}; do
  if service_is_healthy "$NEW_IMAGE"; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  printf 'G6 deployment: health check falló para %s; iniciando rollback\n' "$NEW_IMAGE" >&2
  if [[ -n "$CURRENT_IMAGE" ]]; then
    if compose "$CURRENT_IMAGE" up --detach --no-deps; then
      for attempt in {1..30}; do
        if service_is_healthy "$CURRENT_IMAGE"; then
          printf '%s\n' "$CURRENT_IMAGE" > "${ACTIVE_FILE}.tmp"
          mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"
          fail "nueva imagen no saludable; restaurada ${CURRENT_IMAGE}"
        fi
        sleep 2
      done
    fi
    fail "health check falló y el rollback a ${CURRENT_IMAGE} no se pudo verificar"
  fi
  compose "$NEW_IMAGE" rm --stop --force
  rm -f "$ACTIVE_FILE"
  fail 'health check falló; no había una versión anterior que restaurar'
fi

printf '%s\n' "$NEW_IMAGE" > "${ACTIVE_FILE}.tmp"
mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"
printf '%s\n' "$IMAGE_SHA" > "${G6_SERVICE_STATE_DIR}/active-sha"
printf 'G6 deployment: %s activo %s; anterior registrado en %s\n' "$SERVICE_NAME" "$NEW_IMAGE" "$PREVIOUS_FILE"
