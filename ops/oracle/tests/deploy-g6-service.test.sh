#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
readonly REQUIRE_DOCKER_RUNTIME="${G6_REQUIRE_DOCKER_RUNTIME:-false}"
readonly STAGED_OPS="${TEMP_ROOT}/opt/g6-productos-ofertas/lib"
readonly MOCK_BIN="${TEMP_ROOT}/bin"
readonly STATE_ROOT="${TEMP_ROOT}/var/lib"
readonly IMAGE_SHA=0123456789012345678901234567890123456789
readonly NEXT_SHA=abcdefabcdefabcdefabcdefabcdefabcdefabcd
readonly INVENTORY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:${IMAGE_SHA}"
readonly INVENTORY_NEXT_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:${NEXT_SHA}"
readonly CATALOG_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:${IMAGE_SHA}"
readonly CATALOG_NEXT_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:${NEXT_SHA}"
readonly OLD_INVENTORY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:1111111111111111111111111111111111111111"
readonly OLD_CATALOG_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:2222222222222222222222222222222222222222"
readonly SOURCE_ENGINE="${REPO_ROOT}/ops/oracle/deploy-g6-service.sh"
RUNTIME_NETWORK=''
RUNTIME_PROJECTS=()

cleanup_test() {
  local project compose_file
  if [[ -n "$RUNTIME_NETWORK" ]] && command -v docker >/dev/null 2>&1; then
    for project in "${RUNTIME_PROJECTS[@]}"; do
      compose_file="${TEMP_ROOT}/${project}.yml"
      [[ -f "$compose_file" ]] && docker compose --project-name "$project" --file "$compose_file" down --timeout 0 >/dev/null 2>&1 || true
    done
    docker network rm "$RUNTIME_NETWORK" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMP_ROOT"
}
trap cleanup_test EXIT

fail() {
  printf 'FALLO: %s\n' "$1" >&2
  exit 1
}

[[ "$REQUIRE_DOCKER_RUNTIME" == true || "$REQUIRE_DOCKER_RUNTIME" == false ]] ||
  fail 'G6_REQUIRE_DOCKER_RUNTIME debe ser true o false'

docker_host_path() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$path"
  elif command -v wslpath >/dev/null 2>&1 && [[ "$path" == /mnt/* ]]; then
    wslpath -m "$path"
  else
    printf '%s\n' "$path"
  fi
}

source "${REPO_ROOT}/ops/oracle/service-registry.sh"
[[ "$(g6_enabled_services_json)" == '["api-gateway","bulk-svc","catalog-svc","combos-svc","inventory-svc","price-audit-svc","pricing-svc","promotions-svc","taxonomy-svc"]' ]] || fail 'Los nueve servicios de Hito 3 deben estar habilitados para dispatch manual'
[[ "$(awk -F'|' '$1 !~ /^#/ && NF { count++ } END { print count+0 }' "${REPO_ROOT}/ops/oracle/services.psv")" == 9 ]] ||
  fail 'el registro debe contener exactamente nueve servicios'

mkdir -p "$STAGED_OPS" "$MOCK_BIN" "$STATE_ROOT" \
  "${TEMP_ROOT}/opt/g6-productos-ofertas/inventory" \
  "${TEMP_ROOT}/opt/g6-productos-ofertas/shared" \
  "${TEMP_ROOT}/etc/g6-inventory" \
  "${TEMP_ROOT}/etc/g6-catalog-svc" \
  "${STATE_ROOT}/g6-inventory" \
  "${STATE_ROOT}/g6-productos-ofertas/catalog-svc"
cp "${REPO_ROOT}/ops/oracle/service-registry.sh" "$STAGED_OPS/service-registry.sh"
cp "${REPO_ROOT}/ops/oracle/services.psv" "$STAGED_OPS/services.psv"
cp "$SOURCE_ENGINE" "$STAGED_OPS/deploy-g6-service.sh"
cp "${REPO_ROOT}/ops/oracle/deploy-inventory-svc.sh" "$STAGED_OPS/deploy-inventory-svc.sh"
cp "${REPO_ROOT}/ops/oracle/docker-compose.inventory.http.yml" "$TEMP_ROOT/inventory-http.yml"
cp "${REPO_ROOT}/ops/oracle/docker-compose.service.http.yml" "$TEMP_ROOT/service-http.yml"
sed -i \
  -e "s|/opt/g6-productos-ofertas|${TEMP_ROOT}/opt/g6-productos-ofertas|g" \
  -e "s|/var/lib/g6-inventory|${STATE_ROOT}/g6-inventory|g" \
  -e "s|/var/lib/g6-productos-ofertas|${STATE_ROOT}/g6-productos-ofertas|g" \
  -e "s|/etc/g6-|${TEMP_ROOT}/etc/g6-|g" \
  "$STAGED_OPS/service-registry.sh"
sed -i \
  -e "s|/opt/g6-productos-ofertas|${TEMP_ROOT}/opt/g6-productos-ofertas|g" \
  -e "s|/var/lib/g6-inventory|${STATE_ROOT}/g6-inventory|g" \
  -e "s|/var/lib/g6-productos-ofertas|${STATE_ROOT}/g6-productos-ofertas|g" \
  -e "s|/etc/g6-|${TEMP_ROOT}/etc/g6-|g" \
  "$STAGED_OPS/services.psv"
# Solo en esta copia de pruebas se habilitan catalog-svc y taxonomy-svc para
# simular dos servicios genéricos sin cambiar el registro de producción.
sed -i 's/^catalog-svc|false|/catalog-svc|true|/' "$STAGED_OPS/services.psv"
sed -i 's/^taxonomy-svc|false|/taxonomy-svc|true|/' "$STAGED_OPS/services.psv"
# Elimina esperas únicamente en la copia aislada que usa esta simulación.
sed -i 's/sleep 2/: # espera omitida en simulación/g' "$STAGED_OPS/deploy-g6-service.sh"
sed -i "s|/etc/g6-inventory/runtime.env|${TEMP_ROOT}/etc/g6-inventory/runtime.env|g" "$STAGED_OPS/deploy-g6-service.sh"
sed -i \
  -e "s|/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml|${TEMP_ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml|g" \
  -e "s|/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml|${TEMP_ROOT}/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml|g" \
  "$STAGED_OPS/deploy-g6-service.sh"
sed -i "s|PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|PATH=${MOCK_BIN}:/usr/bin:/bin|g" "$STAGED_OPS/deploy-g6-service.sh"
sed -i "s|/usr/local/lib/g6-productos-ofertas/deploy-g6-service|${STAGED_OPS}/deploy-g6-service.sh|g" "$STAGED_OPS/deploy-inventory-svc.sh"
chmod +x "$STAGED_OPS/deploy-g6-service.sh"

version_output="$(env -u SSH_ORIGINAL_COMMAND bash "$STAGED_OPS/deploy-g6-service.sh" --version)"
[[ "$version_output" == 'ejecutor=5 registro=2' ]] || fail "versiones instaladas inesperadas: $version_output"
cp "$STAGED_OPS/services.psv" "${TEMP_ROOT}/services.psv.version-backup"
sed -i 's/^#registry-version=2$/#registry-version=9/' "$STAGED_OPS/services.psv"
if env -u SSH_ORIGINAL_COMMAND bash "$STAGED_OPS/deploy-g6-service.sh" --version >"${TEMP_ROOT}/result.log" 2>&1; then
  fail 'la versión incompatible del registro no fue rechazada'
fi
mv "${TEMP_ROOT}/services.psv.version-backup" "$STAGED_OPS/services.psv"
printf 'CORRECTO: versión del registro y ejecutor informada y compatibilidad obligatoria\n'
touch "${TEMP_ROOT}/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml"
touch "${TEMP_ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.yml"
printf '%s\n' 'DATABASE_URL=test-only' > "${TEMP_ROOT}/etc/g6-inventory/runtime.env"
: > "${TEMP_ROOT}/etc/g6-catalog-svc/runtime.env"
cp "${REPO_ROOT}/docker-compose.inventory.yml" "${TEMP_ROOT}/docker-compose.inventory.yml"
INVENTORY_RUNTIME_ENV_DOCKER_PATH="$(docker_host_path "${TEMP_ROOT}/etc/g6-inventory/runtime.env")"
CATALOG_RUNTIME_ENV_DOCKER_PATH="$(docker_host_path "${TEMP_ROOT}/etc/g6-catalog-svc/runtime.env")"
sed -i "s|/etc/g6-inventory/runtime.env|${INVENTORY_RUNTIME_ENV_DOCKER_PATH}|g" \
  "${TEMP_ROOT}/docker-compose.inventory.yml"

validate_compose_files() {
  local service port port_env config
  while IFS='|' read -r service enabled port port_env _; do
    [[ -n "$service" && "$service" != \#* && "$service" != inventory-svc ]] || continue
    config="$(env G6_SERVICE_IMAGE="ghcr.io/example/${service}:0123456789012345678901234567890123456789" \
      G6_SERVICE_CONTAINER="g6-${service}" G6_SERVICE_PORT="$port" G6_SERVICE_PORT_ENV="$port_env" \
      G6_SERVICE_IMAGE_NAME="$service" G6_SERVICE_ENV_FILE="$CATALOG_RUNTIME_ENV_DOCKER_PATH" \
      docker compose --project-name "g6-${service}" \
        --file "${REPO_ROOT}/ops/oracle/docker-compose.service.yml" \
        --file "${REPO_ROOT}/ops/oracle/docker-compose.service.http.yml" config --format yaml)" ||
      fail "Compose inválido para ${service}"
    grep -Fq 'external: true' <<< "$config" || fail "g6-http no quedó externo para ${service}"
    grep -Fq -- "- ${service}" <<< "$config" || fail "alias DNS no coincide para ${service}"
    grep -Fq 'host_ip: 127.0.0.1' <<< "$config" || fail "el puerto de ${service} dejó de ser loopback"
    if grep -Fq 'host_ip: 0.0.0.0' <<< "$config"; then fail "Compose publicó ${service} en todas las interfaces"; fi
  done < "${REPO_ROOT}/ops/oracle/services.psv"

  config="$(env INVENTORY_IMAGE='ghcr.io/example/inventory-svc:0123456789012345678901234567890123456789' \
    docker compose --project-name g6-inventory \
      --file "${TEMP_ROOT}/docker-compose.inventory.yml" \
      --file "${REPO_ROOT}/ops/oracle/docker-compose.inventory.http.yml" config --format yaml)" ||
    fail 'Compose de Inventory con g6-http inválido'
  grep -Fq 'published: "3005"' <<< "$config" || fail 'Inventory dejó de conservar el puerto 3005'
  grep -Fq 'host_ip: 127.0.0.1' <<< "$config" || fail 'Inventory dejó de publicar solo en loopback'
  grep -Fq 'http://127.0.0.1:3005/health' <<< "$config" || fail 'Inventory dejó de verificar /health'
  grep -Fq -- '- inventory-svc' <<< "$config" || fail 'alias DNS de Inventory inesperado'
  grep -Fq 'source: /etc/g6-postgres/supabase-server-root.crt' <<< "$config" || fail 'Inventory no monta la CA PostgreSQL esperada'
  grep -Fq 'target: /run/g6-certs/supabase-server-root.crt' <<< "$config" || fail 'ruta de destino de la CA PostgreSQL inesperada'
  grep -Fq 'read_only: true' <<< "$config" || fail 'el montaje de CA PostgreSQL de Inventory no es de solo lectura'

  local required_var variable_name env_assignment
  local -a compose_env
  for required_var in G6_SERVICE_IMAGE G6_SERVICE_CONTAINER G6_SERVICE_PORT G6_SERVICE_PORT_ENV G6_SERVICE_IMAGE_NAME G6_SERVICE_ENV_FILE; do
    compose_env=()
    while IFS= read -r env_assignment; do
      variable_name="${env_assignment%%=*}"
      [[ "$variable_name" == "$required_var" ]] || compose_env+=("$env_assignment")
    done <<'REQUIRED_COMPOSE_ENV'
G6_SERVICE_IMAGE=ghcr.io/example/catalog-svc:0123456789012345678901234567890123456789
G6_SERVICE_CONTAINER=g6-catalog-svc
G6_SERVICE_PORT=3001
G6_SERVICE_PORT_ENV=CATALOG_SVC_PORT
G6_SERVICE_IMAGE_NAME=catalog-svc
G6_SERVICE_ENV_FILE=/tmp/g6-catalog-runtime.env
REQUIRED_COMPOSE_ENV
    if env -u "$required_var" "${compose_env[@]}" \
      docker compose --project-name g6-catalog-svc \
        --file "${REPO_ROOT}/ops/oracle/docker-compose.service.yml" \
        --file "${REPO_ROOT}/ops/oracle/docker-compose.service.http.yml" config --quiet >/dev/null 2>&1; then
      fail "Compose aceptó la ausencia de ${required_var}"
    fi
  done
  if env -u INVENTORY_IMAGE \
    docker compose --project-name g6-inventory --file "${TEMP_ROOT}/docker-compose.inventory.yml" \
      --file "${REPO_ROOT}/ops/oracle/docker-compose.inventory.http.yml" config --quiet >/dev/null 2>&1; then
    fail 'Compose aceptó la ausencia de INVENTORY_IMAGE'
  fi
  printf 'CORRECTO: docker compose config validado para los nueve servicios y overlays; aliases, healthchecks y puertos loopback conservados\n'
}

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  validate_compose_files
else
  [[ "$REQUIRE_DOCKER_RUNTIME" != true ]] || fail 'Docker Compose es obligatorio pero no está disponible'
  printf 'NO EJECUTADO: docker compose config no está disponible en este entorno\n'
fi

cat > "${MOCK_BIN}/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ACTIVE_DIR="${ROOT}/var/lib/containers"
mkdir -p "$ACTIVE_DIR"

if [[ "${1:-}" == login ]]; then
  [[ "$(cat)" == 'simulation-only-token' ]] || exit 90
  [[ "$*" == *'--username simulation-only-user'* ]] || exit 91
  exit 0
fi

if [[ "${1:-}" == network && "${2:-}" == inspect ]]; then
  format=''
  network=''
  if [[ "${3:-}" == --format ]]; then format="${4:-}"; network="${5:-}"; else network="${3:-}"; fi
  [[ "$network" == g6-http ]] || exit 89
  printf 'inspect g6-http\n' >> "${ROOT}/network.log"
  [[ -f "${ROOT}/g6-http-present" ]] || exit 1
  case "$format" in
    '') exit 0 ;;
    *'IPAM.Driver'*'len .IPAM.Config'*'len .Options'*)
      [[ -f "${ROOT}/g6-http-config" ]] || exit 1
      cat "${ROOT}/g6-http-config"
      ;;
    *'.Containers'*'.Name'*)
      [[ ! -f "${ROOT}/network-members.tsv" ]] || cut -d'|' -f1 "${ROOT}/network-members.tsv"
      ;;
    *) exit 88 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == inspect ]]; then
  format="${3:-}"
  container="${4:-}"
  if [[ "$format" == *'Config.Labels'*'com.docker.compose.service'* ]]; then
    awk -F'|' -v container="$container" '$1 == container { print $3 "|" $4 }' \
      "${ROOT}/network-members.tsv" 2>/dev/null || true
    exit 0
  fi
  if [[ "$format" == *'NetworkSettings.Networks'*'Aliases'* ]]; then
    awk -F'|' -v container="$container" '$1 == container { n = split($2, aliases, ","); for (i = 1; i <= n; i++) if (aliases[i] != "") print aliases[i] }' \
      "${ROOT}/network-members.tsv" 2>/dev/null || true
    exit 0
  fi
  active_file="${ACTIVE_DIR}/${container}"
  [[ -f "$active_file" ]] || exit 1
  image="$(<"$active_file")"
  if [[ "$format" == '{{.Config.Image}}' ]]; then
    printf '%s\n' "$image"
    exit 0
  fi
  if [[ "$format" == '{{.State.Health.Status}}' ]]; then
    if [[ -f "${ROOT}/unhealthy-docker-image" && "$(<"${ROOT}/unhealthy-docker-image")" == "$image" ]]; then
      printf 'unhealthy\n'
    else
      printf 'healthy\n'
    fi
    exit 0
  fi
  exit 94
fi

[[ "${1:-}" == compose ]] || exit 92
project=''
for ((index = 1; index < $#; index++)); do
  if [[ "${!index}" == --project-name ]]; then
    next=$((index + 1))
    project="${!next}"
    break
  fi
done
case "$project" in
  g6-inventory) container=g6-inventory-svc ;;
  g6-catalog-svc) container=g6-catalog-svc ;;
  *) exit 93 ;;
esac
operation=''
for argument in "$@"; do
  case "$argument" in pull|up|rm) operation="$argument" ;; esac
done
if [[ "$container" == g6-inventory-svc ]]; then image="${INVENTORY_IMAGE:-}"; else image="${G6_SERVICE_IMAGE:-}"; fi
printf '%s %s %s\n' "$project" "$operation" "$image" >> "${ROOT}/docker.log"
printf '%s\n' "$*" >> "${ROOT}/docker-args.log"
if [[ "$container" == g6-catalog-svc && -f "${ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml" ]]; then
  [[ "$*" == *"${ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml"* ]] || exit 98
  [[ "${G6_SERVICE_IMAGE_NAME:-}" == catalog-svc ]] || exit 99
fi
if [[ "$container" == g6-inventory-svc && -f "${ROOT}/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml" ]]; then
  [[ "$*" == *"${ROOT}/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml"* ]] || exit 98
fi
printf '%s\n' "$container" > "${ROOT}/target-container"

wait_for_release() {
  local marker="$1"
  touch "${ROOT}/${marker}-started"
  for attempt in {1..500}; do
    [[ ! -e "${ROOT}/${marker}-release" ]] || return 0
    /bin/sleep 0.01
  done
  echo "mock operation timed out waiting for ${marker}-release" >&2
  exit 97
}

case "$operation" in
  pull)
    if [[ -f "${ROOT}/block-pull" && "$(<"${ROOT}/block-pull")" == "$image" ]]; then
      wait_for_release pull
    fi
    if [[ -f "${ROOT}/fail-pull" && "$(<"${ROOT}/fail-pull")" == "$image" ]]; then exit 1; fi
    ;;
  up)
    if [[ -f "${ROOT}/block-up" && "$(<"${ROOT}/block-up")" == "$image" ]]; then
      wait_for_release rollback
    fi
    if [[ -f "${ROOT}/fail-up" && "$(<"${ROOT}/fail-up")" == "$image" ]]; then exit 1; fi
    printf '%s\n' "$image" > "${ACTIVE_DIR}/${container}"
    ;;
  rm) rm -f "${ACTIVE_DIR}/${container}" ;;
  *) exit 95 ;;
esac
MOCK_DOCKER

cat > "${MOCK_BIN}/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_file=''
url=''
while (($#)); do
  case "$1" in
    --output) output_file="$2"; shift 2 ;;
    --write-out) [[ "$2" == '%{http_code}' ]] || exit 9; shift 2 ;;
    --max-time) [[ "$2" == 2 ]] || exit 10; shift 2 ;;
    --fail|--silent|--show-error) shift ;;
    http://*) url="$1"; shift ;;
    *) exit 11 ;;
  esac
done
container="$(<"${ROOT}/target-container")"
active_file="${ROOT}/var/lib/containers/${container}"
[[ -f "$active_file" ]] || exit 7
image="$(<"$active_file")"
[[ "$url" == "http://127.0.0.1:${MOCK_EXPECTED_PORT}/health" ||
  "$url" == "http://127.0.0.1:${MOCK_EXPECTED_PORT}/health/ready" ]] || exit 12
if [[ -z "$output_file" ]]; then
  [[ "$url" == "http://127.0.0.1:${MOCK_EXPECTED_PORT}/health" ]] || exit 13
  if [[ -f "${ROOT}/unhealthy-http-image" && "$(<"${ROOT}/unhealthy-http-image")" == "$image" ]]; then exit 8; fi
  exit 0
fi
if [[ -f "${ROOT}/unhealthy-http-image" && "$(<"${ROOT}/unhealthy-http-image")" == "$image" && "$url" == */health ]]; then exit 8; fi
if [[ "$url" == */health/ready ]]; then
  printf '%s\n' "$image" >> "${ROOT}/readiness-probes.log"
  if [[ -f "${ROOT}/forbid-active-image" && "$(<"${ROOT}/forbid-active-image")" == "$image" &&
    -f "${MOCK_ACTIVE_IMAGE_FILE:-/nonexistent}" && "$(<"${MOCK_ACTIVE_IMAGE_FILE}")" == "$image" ]]; then
    exit 29
  fi
  if [[ -f "${ROOT}/timeout-readiness-image" && "$(<"${ROOT}/timeout-readiness-image")" == "$image" ]]; then exit 28; fi
  if [[ -f "${ROOT}/unready-readiness-image" && "$(<"${ROOT}/unready-readiness-image")" == "$image" ]]; then
    printf '%s\n' '{"service":"catalog-svc","status":"not_ready"}' > "$output_file"
    printf '503'
    exit 0
  fi
  printf '%s\n' '{"service":"catalog-svc","status":"ready","database":"ready"}' > "$output_file"
else
  : > "$output_file"
fi
printf '200'
MOCK_CURL
cat > "${MOCK_BIN}/jq" <<'MOCK_JQ'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == -e && "${2:-}" == 'type == "object" and .service == "catalog-svc" and .status == "ready"' ]]
[[ "$(<"${3:?}")" == '{"service":"catalog-svc","status":"ready","database":"ready"}' ]]
printf 'true\n'
MOCK_JQ
cat > "${MOCK_BIN}/sleep" <<'MOCK_SLEEP'
#!/usr/bin/env bash
exit 0
MOCK_SLEEP
chmod +x "${MOCK_BIN}/docker" "${MOCK_BIN}/curl" "${MOCK_BIN}/jq" "${MOCK_BIN}/sleep"
printf '%s\n' 'bridge|local|false|false|false|false|default|1|0' > "${TEMP_ROOT}/g6-http-config"
: > "${TEMP_ROOT}/network-members.tsv"

reset_simulation() {
  rm -rf "${TEMP_ROOT}/var/lib/containers"
  mkdir -p "${TEMP_ROOT}/var/lib/containers"
  rm -f "${TEMP_ROOT}/docker.log" "${TEMP_ROOT}/target-container" \
    "${TEMP_ROOT}/docker-args.log" "${TEMP_ROOT}/readiness-probes.log" \
    "${TEMP_ROOT}/network.log" \
    "${TEMP_ROOT}/fail-pull" "${TEMP_ROOT}/fail-up" \
    "${TEMP_ROOT}/unhealthy-docker-image" "${TEMP_ROOT}/unhealthy-http-image" \
    "${TEMP_ROOT}/unready-readiness-image" "${TEMP_ROOT}/timeout-readiness-image" \
    "${TEMP_ROOT}/forbid-active-image" \
    "${TEMP_ROOT}/block-pull" "${TEMP_ROOT}/block-up" \
    "${TEMP_ROOT}/pull-started" "${TEMP_ROOT}/pull-release" \
    "${TEMP_ROOT}/rollback-started" "${TEMP_ROOT}/rollback-release"
}

run_deploy() {
  local command="$1" port="$2" expected_status="$3" executable="${4:-${STAGED_OPS}/deploy-g6-service.sh}" result
  if printf '%s\n%s\n' 'simulation-only-user' 'simulation-only-token' |
    env PATH="${MOCK_BIN}:${PATH}" SSH_ORIGINAL_COMMAND="$command" MOCK_EXPECTED_PORT="$port" \
      MOCK_ACTIVE_IMAGE_FILE="${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" \
      bash "$executable" > "${TEMP_ROOT}/result.log" 2>&1; then
    result=0
  else
    result=$?
  fi
  [[ "$result" == "$expected_status" ]] || fail "${command}: exit ${result}, esperado ${expected_status}: $(<"${TEMP_ROOT}/result.log")"
}

assert_value() {
  local path="$1" expected="$2"
  local actual=''
  [[ ! -f "$path" ]] || actual="$(<"$path")"
  [[ -f "$path" && "$actual" == "$expected" ]] || fail "valor inesperado en ${path}: '${actual}', esperado '${expected}'"
}

start_deploy() {
  local command="$1" port="$2" output="$3" executable="${4:-${STAGED_OPS}/deploy-g6-service.sh}"
  printf '%s\n%s\n' 'simulation-only-user' 'simulation-only-token' |
    env PATH="${MOCK_BIN}:${PATH}" SSH_ORIGINAL_COMMAND="$command" MOCK_EXPECTED_PORT="$port" \
      bash "$executable" > "$output" 2>&1 &
  STARTED_PID=$!
}

wait_for_marker() {
  local marker="$1"
  for attempt in {1..500}; do
    [[ ! -e "${TEMP_ROOT}/${marker}" ]] || return 0
    /bin/sleep 0.01
  done
  fail "no apareció el marcador ${marker}"
}

assert_only_blocked_operation_logged() {
  local expected="$1"
  [[ "$(<"${TEMP_ROOT}/docker.log")" == "$expected" ]] ||
    fail "hubo operaciones simultáneas antes de liberar flock: $(<"${TEMP_ROOT}/docker.log")"
}

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "inventory-deploy ${IMAGE_SHA}" 3005 0 "${STAGED_OPS}/deploy-inventory-svc.sh"
assert_value "${STATE_ROOT}/g6-inventory/active-image" "$INVENTORY_IMAGE"
assert_value "${STATE_ROOT}/g6-inventory/previous-image" "$OLD_INVENTORY_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" "$OLD_CATALOG_IMAGE"
[[ "$(<"${TEMP_ROOT}/docker.log")" == $'g6-inventory pull ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789\ng6-inventory up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789' ]] || fail 'Inventario no conservó su proyecto, puerto o flujo de operaciones'
printf 'CORRECTO: comando SSH anterior y aislamiento de inventory-svc\n'

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
printf '%s\n' "$CATALOG_IMAGE" > "${TEMP_ROOT}/forbid-active-image"
run_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 0
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$CATALOG_IMAGE"
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/previous-image" "$OLD_CATALOG_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc" "$OLD_INVENTORY_IMAGE"
grep -Fq "${CATALOG_IMAGE}" "${TEMP_ROOT}/readiness-probes.log" || fail 'Catalog no ejecutó su gate de readiness'
[[ "$(<"${TEMP_ROOT}/docker.log")" == $'g6-catalog-svc pull ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:0123456789012345678901234567890123456789\ng6-catalog-svc up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:0123456789012345678901234567890123456789' ]] || fail 'catalog-svc alteró un proyecto o servicio no seleccionado'
printf 'CORRECTO: ejecución genérica de catalog-svc aislada de Inventario\n'

# Sin el overlay opt-in, una instalación previa no necesita conocer g6-http.
reset_simulation
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 0
[[ ! -f "${TEMP_ROOT}/network.log" ]] || fail 'el despliegue anterior inspeccionó una red no habilitada'
printf 'CORRECTO: despliegue genérico conserva compatibilidad cuando el overlay no está instalado\n'

# El overlay es opt-in y exige que la red ya exista antes de pull/up.
cp "$TEMP_ROOT/service-http.yml" "${TEMP_ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml"
reset_simulation
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutaron operaciones Compose con g6-http ausente'
[[ -f "${TEMP_ROOT}/network.log" ]] || fail 'no se verificó la existencia de g6-http'
assert_value "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" "$OLD_CATALOG_IMAGE"
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' 'bridge|local|false|false|false|false|default|1|0' > "${TEMP_ROOT}/g6-http-config"
: > "${TEMP_ROOT}/network-members.tsv"
: > "${TEMP_ROOT}/network.log"
run_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 0
[[ "$(<"${TEMP_ROOT}/network.log")" == $'inspect g6-http\ninspect g6-http' ]] || fail 'preflight de g6-http no fue determinista'
printf 'host|local|false|false|false|false|default|1|0\n' > "${TEMP_ROOT}/g6-http-config"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con driver de g6-http incompatible'
assert_value "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" "$OLD_CATALOG_IMAGE"
printf '%s\n' 'bridge|local|true|false|false|false|default|1|0' > "${TEMP_ROOT}/g6-http-config"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con g6-http internal'
printf '%s\n' 'bridge|local|false|true|false|false|default|1|0' > "${TEMP_ROOT}/g6-http-config"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con g6-http attachable inesperado'
printf '%s\n' 'bridge|local|false|false|false|false|custom|1|1' > "${TEMP_ROOT}/g6-http-config"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con IPAM u opciones no aprobadas'
printf '%s\n' 'bridge|local|false|false|false|false|default|1|0' > "${TEMP_ROOT}/g6-http-config"
printf '%s\n' 'g6-rabbitmq|rabbitmq|rabbitmq|g6-rabbitmq' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con miembro no habilitado en g6-http'
printf '%s\n' 'g6-inventory-svc|catalog-svc,inventory-svc|inventory-svc|g6-inventory' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con alias del servicio objetivo ocupado'
printf '%s\n' 'g6-inventory-svc|inventory-svc|inventory-svc|g6-inventory' 'g6-catalog-svc|inventory-svc|service|g6-catalog-svc' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con aliases duplicados entre miembros'
printf '%s\n' 'g6-catalog-svc|catalog-svc,service|service|g6-catalog-svc' 'g6-taxonomy-svc|taxonomy-svc,service|service|g6-taxonomy-svc' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 0
printf 'CORRECTO: dos servicios genéricos comparten solo el alias implícito service y conservan aliases canónicos únicos\n'
printf '%s\n' 'g6-catalog-svc|catalog-svc,service|service|g6-catalog-svc' 'g6-taxonomy-svc|catalog-svc,service|service|g6-taxonomy-svc' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose con alias canónico duplicado entre servicios'
printf '%s\n' 'g6-inventory-svc|inventory-svc,service|inventory-svc|g6-inventory' 'g6-catalog-svc|catalog-svc,service|service|g6-catalog-svc' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose al compartir service con un miembro no genérico'
printf '%s\n' 'g6-inventory-svc|wrong-alias|inventory-svc|g6-inventory' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail 'se ejecutó Compose sin el alias canónico del miembro'
printf '%s\n' 'g6-inventory-svc|inventory-svc|inventory-svc|g6-inventory' > "${TEMP_ROOT}/network-members.tsv"
reset_simulation
touch "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
run_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 0
printf 'CORRECTO: red externa valida configuración, miembros y colisiones de alias antes de pull/up\n'
printf 'CORRECTO: overlay solo se aplica con g6-http preparado y aliases validados\n'

# Inventory mantiene el comando/Compose legado incluso si hay overlay genérico;
# su overlay dedicado solo se usa al instalarlo expresamente.
cp "$TEMP_ROOT/inventory-http.yml" "${TEMP_ROOT}/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml"
reset_simulation
rm -f "${TEMP_ROOT}/g6-http-present"
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
run_deploy "inventory-deploy ${IMAGE_SHA}" 3005 1 "${STAGED_OPS}/deploy-inventory-svc.sh"
[[ -f "${TEMP_ROOT}/network.log" ]] || fail 'Inventory no verificó g6-http al activar su overlay'
touch "${TEMP_ROOT}/g6-http-present"
reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
run_deploy "inventory-deploy ${IMAGE_SHA}" 3005 0 "${STAGED_OPS}/deploy-inventory-svc.sh"
grep -Fq "${TEMP_ROOT}/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml" \
  "${TEMP_ROOT}/docker-args.log" || fail 'Inventory no aplicó su overlay explícito'
[[ "$(<"${TEMP_ROOT}/docker.log")" == $'g6-inventory pull ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789\ng6-inventory up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789' ]] ||
  fail 'Inventory cambió el proyecto o las operaciones Compose del flujo legado'
printf 'CORRECTO: Inventory legacy conserva wrapper, proyecto, 3005 y overlay opt-in\n'

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
printf '%s\n' "$CATALOG_NEXT_IMAGE" > "${TEMP_ROOT}/unhealthy-http-image"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$OLD_CATALOG_IMAGE"
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/previous-image" "$OLD_CATALOG_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc" "$OLD_INVENTORY_IMAGE"
[[ "$(<"${TEMP_ROOT}/docker.log")" == $'g6-catalog-svc pull ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:abcdefabcdefabcdefabcdefabcdefabcdefabcd\ng6-catalog-svc up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:abcdefabcdefabcdefabcdefabcdefabcdefabcd\ng6-catalog-svc up ghcr.io/taller-sw-web/g6-productos-ofertas-backend/catalog-svc:2222222222222222222222222222222222222222' ]] || fail 'rollback genérico no quedó confinado al servicio catalog-svc'
printf 'CORRECTO: rollback catalog-svc sin modificar inventory-svc\n'

reset_simulation
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
printf '%s\n' "$CATALOG_NEXT_IMAGE" > "${TEMP_ROOT}/unready-readiness-image"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$OLD_CATALOG_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" "$OLD_CATALOG_IMAGE"
[[ "$(grep -Fxc "$CATALOG_NEXT_IMAGE" "${TEMP_ROOT}/readiness-probes.log")" == 30 ]] ||
  fail 'Catalog no limitó a 30 intentos la readiness 503'
printf 'CORRECTO: Catalog healthy con readiness 503 falla y restaura la imagen anterior\n'

reset_simulation
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
printf '%s\n' "$CATALOG_NEXT_IMAGE" > "${TEMP_ROOT}/timeout-readiness-image"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$OLD_CATALOG_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" "$OLD_CATALOG_IMAGE"
[[ "$(grep -Fxc "$CATALOG_NEXT_IMAGE" "${TEMP_ROOT}/readiness-probes.log")" == 30 ]] ||
  fail 'Catalog no limitó a 30 intentos el timeout de readiness'
printf 'CORRECTO: timeout de readiness Catalog falla y restaura la imagen anterior\n'

reset_simulation
rm -f "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" \
  "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" \
  "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/previous-image"
printf '%s\n' "$CATALOG_NEXT_IMAGE" > "${TEMP_ROOT}/unready-readiness-image"
run_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 1
[[ ! -e "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" ]] ||
  fail 'Catalog sin imagen anterior declaró active-image pese a readiness fallida'
[[ ! -e "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" ]] ||
  fail 'Catalog sin imagen anterior no eliminó el contenedor candidato fallido'
printf 'CORRECTO: sin versión previa no se declara Catalog activo y se elimina el candidato\n'

reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$INVENTORY_NEXT_IMAGE" > "${TEMP_ROOT}/unhealthy-http-image"
run_deploy "inventory-deploy ${NEXT_SHA}" 3005 1 "${STAGED_OPS}/deploy-inventory-svc.sh"
assert_value "${STATE_ROOT}/g6-inventory/active-image" "$OLD_INVENTORY_IMAGE"
assert_value "${STATE_ROOT}/g6-inventory/previous-image" "$OLD_INVENTORY_IMAGE"
printf 'CORRECTO: rollback de Inventario mantiene imagen y estado previos\n'

for invalid_command in \
  'service-deploy unknown-svc 0123456789012345678901234567890123456789' \
  'service-deploy pricing-svc 0123456789012345678901234567890123456789' \
  'service-deploy catalog-svc ../../etc/passwd' \
  'service-deploy catalog-svc 0123456789012345678901234567890123456789;id' \
  'inventory-deploy 01234567890123456789012345678901234567890' \
  'service-deploy catalog-svc 0123456789012345678901234567890123456789 extra'; do
  reset_simulation
  run_deploy "$invalid_command" 3001 1
  [[ ! -s "${TEMP_ROOT}/docker.log" ]] || fail "entrada rechazada ejecutó operaciones Docker: ${invalid_command}"
done
printf 'CORRECTO: nombres no registrados y entradas inválidas rechazadas\n'

# Dos despliegues del mismo servicio se serializan en el host y el estado final
# conserva active-image/previous-image como pares coherentes.
reset_simulation
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
printf '%s\n' "$CATALOG_NEXT_IMAGE" > "${TEMP_ROOT}/block-pull"
start_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 "${TEMP_ROOT}/first-deploy.log"
first_pid="$STARTED_PID"
wait_for_marker pull-started
start_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 "${TEMP_ROOT}/second-deploy.log"
second_pid="$STARTED_PID"
/bin/sleep 0.15
assert_only_blocked_operation_logged "g6-catalog-svc pull ${CATALOG_NEXT_IMAGE}"
touch "${TEMP_ROOT}/pull-release"
wait "$first_pid" || fail 'el primer despliegue concurrente falló'
wait "$second_pid" || fail 'el segundo despliegue concurrente falló'
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$CATALOG_IMAGE"
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/previous-image" "$CATALOG_NEXT_IMAGE"
expected_log="$(printf '%s\n' "g6-catalog-svc pull ${CATALOG_NEXT_IMAGE}" "g6-catalog-svc up ${CATALOG_NEXT_IMAGE}" "g6-catalog-svc pull ${CATALOG_IMAGE}" "g6-catalog-svc up ${CATALOG_IMAGE}")"
[[ "$(<"${TEMP_ROOT}/docker.log")" == "$expected_log" ]] || fail 'el orden de despliegues concurrentes se corrompió'
printf 'CORRECTO: despliegues concurrentes serializados y estado activo/anterior coherente\n'

# El bloqueo también cubre la fase de rollback; otro despliegue espera hasta
# que la restauración y la escritura de estado terminen.
reset_simulation
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc"
printf '%s\n' "$CATALOG_NEXT_IMAGE" > "${TEMP_ROOT}/unhealthy-http-image"
printf '%s\n' "$OLD_CATALOG_IMAGE" > "${TEMP_ROOT}/block-up"
start_deploy "service-deploy catalog-svc ${NEXT_SHA}" 3001 "${TEMP_ROOT}/rollback-deploy.log"
rollback_pid="$STARTED_PID"
wait_for_marker rollback-started
start_deploy "service-deploy catalog-svc ${IMAGE_SHA}" 3001 "${TEMP_ROOT}/after-rollback.log"
after_rollback_pid="$STARTED_PID"
/bin/sleep 0.15
expected_log="$(printf '%s\n' "g6-catalog-svc pull ${CATALOG_NEXT_IMAGE}" "g6-catalog-svc up ${CATALOG_NEXT_IMAGE}" "g6-catalog-svc up ${OLD_CATALOG_IMAGE}")"
assert_only_blocked_operation_logged "$expected_log"
touch "${TEMP_ROOT}/rollback-release"
if wait "$rollback_pid"; then fail 'el despliegue no saludable debió informar rollback'; fi
wait "$after_rollback_pid" || fail 'el despliegue posterior al rollback falló'
assert_value "${STATE_ROOT}/g6-productos-ofertas/catalog-svc/active-image" "$CATALOG_IMAGE"
assert_value "${TEMP_ROOT}/var/lib/containers/g6-catalog-svc" "$CATALOG_IMAGE"
printf 'CORRECTO: rollback concurrente protegido del siguiente despliegue\n'

# El wrapper legado usado por Inventory y el comando genérico terminan en el
# mismo lock local, por lo que manual/automático no pueden pisar su estado.
reset_simulation
printf '%s\n' "$OLD_INVENTORY_IMAGE" > "${TEMP_ROOT}/var/lib/containers/g6-inventory-svc"
printf '%s\n' "$INVENTORY_NEXT_IMAGE" > "${TEMP_ROOT}/block-pull"
start_deploy "inventory-deploy ${NEXT_SHA}" 3005 "${TEMP_ROOT}/manual-inventory.log" "${STAGED_OPS}/deploy-inventory-svc.sh"
manual_pid="$STARTED_PID"
wait_for_marker pull-started
start_deploy "service-deploy inventory-svc ${IMAGE_SHA}" 3005 "${TEMP_ROOT}/automatic-inventory.log"
automatic_pid="$STARTED_PID"
/bin/sleep 0.15
assert_only_blocked_operation_logged "g6-inventory pull ${INVENTORY_NEXT_IMAGE}"
touch "${TEMP_ROOT}/pull-release"
wait "$manual_pid" || fail 'el comando SSH compatible de Inventario falló'
wait "$automatic_pid" || fail 'el segundo deploy de Inventario falló'
assert_value "${STATE_ROOT}/g6-inventory/active-image" "$INVENTORY_IMAGE"
assert_value "${STATE_ROOT}/g6-inventory/previous-image" "$INVENTORY_NEXT_IMAGE"
printf 'CORRECTO: wrapper manual y comando genérico automático comparten exclusión de Inventario\n'

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1 &&
  docker image inspect inventory-svc:ci >/dev/null 2>&1; then
  RUNTIME_PROJECT_CATALOG=g6-catalog-svc
  RUNTIME_PROJECT_TAXONOMY=g6-taxonomy-svc
  if docker inspect g6-catalog-svc >/dev/null 2>&1 || docker inspect g6-taxonomy-svc >/dev/null 2>&1 ||
    [[ -n "$(docker ps -aq --filter label=com.docker.compose.project="$RUNTIME_PROJECT_CATALOG")" ]] ||
    [[ -n "$(docker ps -aq --filter label=com.docker.compose.project="$RUNTIME_PROJECT_TAXONOMY")" ]] ||
    docker network inspect "${RUNTIME_PROJECT_CATALOG}_default" >/dev/null 2>&1 ||
    docker network inspect "${RUNTIME_PROJECT_TAXONOMY}_default" >/dev/null 2>&1; then
    [[ "$REQUIRE_DOCKER_RUNTIME" != true ]] ||
      fail 'los recursos Docker requeridos para aliases reales ya existen; no se modificaron'
    printf 'NO EJECUTADO: recursos Docker de los proyectos del registro ya existen; se evita tocarlos\n'
  else
    candidate_network="g6-h5-${BASHPID}"
    if docker network inspect "$candidate_network" >/dev/null 2>&1; then
      fail 'el nombre aleatorio de red de la prueba ya existe'
    fi
    docker network create --driver bridge "$candidate_network" >/dev/null
    RUNTIME_NETWORK="$candidate_network"
    RUNTIME_PROJECTS=("$RUNTIME_PROJECT_CATALOG" "$RUNTIME_PROJECT_TAXONOMY")

    write_runtime_compose() {
      local path="$1" container="$2" alias="$3"
      cat > "$path" <<RUNTIME_COMPOSE
services:
  service:
    image: inventory-svc:ci
    container_name: ${container}
    entrypoint: ["node", "-e"]
    command: ["setInterval(() => {}, 1000)"]
    networks:
      http:
        aliases:
          - ${alias}
networks:
  http:
    external: true
    name: ${RUNTIME_NETWORK}
RUNTIME_COMPOSE
    }

    write_runtime_compose "${TEMP_ROOT}/${RUNTIME_PROJECT_CATALOG}.yml" g6-catalog-svc catalog-svc
    write_runtime_compose "${TEMP_ROOT}/${RUNTIME_PROJECT_TAXONOMY}.yml" g6-taxonomy-svc taxonomy-svc
    docker compose --project-name "$RUNTIME_PROJECT_CATALOG" --file "${TEMP_ROOT}/${RUNTIME_PROJECT_CATALOG}.yml" up -d
    docker compose --project-name "$RUNTIME_PROJECT_TAXONOMY" --file "${TEMP_ROOT}/${RUNTIME_PROJECT_TAXONOMY}.yml" up -d

    aliases_template='{{range $name, $network := .NetworkSettings.Networks}}{{if eq $name "'
    aliases_template+="${RUNTIME_NETWORK}"
    aliases_template+='"}}{{range $network.Aliases}}{{println .}}{{end}}{{end}}{{end}}'
    catalog_aliases="$(docker inspect --format "$aliases_template" g6-catalog-svc)"
    taxonomy_aliases="$(docker inspect --format "$aliases_template" g6-taxonomy-svc)"
    grep -Fxq service <<< "$catalog_aliases" || fail 'Docker Compose no registró el alias implícito service para catalog-svc'
    grep -Fxq service <<< "$taxonomy_aliases" || fail 'Docker Compose no registró el alias implícito service para taxonomy-svc'
    grep -Fxq catalog-svc <<< "$catalog_aliases" || fail 'alias Docker canónico catalog-svc ausente'
    grep -Fxq taxonomy-svc <<< "$taxonomy_aliases" || fail 'alias Docker canónico taxonomy-svc ausente'
    grep -Fxq taxonomy-svc <<< "$catalog_aliases" && fail 'taxonomy-svc colisionó con el alias canónico de catalog-svc'
    grep -Fxq catalog-svc <<< "$taxonomy_aliases" && fail 'catalog-svc colisionó con el alias canónico de taxonomy-svc'
    printf 'CORRECTO: aliases reales Docker catalog-svc=[%s] taxonomy-svc=[%s]\n' \
      "$(tr '\n' ' ' <<< "$catalog_aliases" | sed 's/[[:space:]]*$//')" \
      "$(tr '\n' ' ' <<< "$taxonomy_aliases" | sed 's/[[:space:]]*$//')"

    LIVE_ROOT="${TEMP_ROOT}/live"
    mkdir -p "${LIVE_ROOT}/lib" "${LIVE_ROOT}/opt/g6-productos-ofertas/shared" \
      "${LIVE_ROOT}/etc/g6-catalog-svc" "${LIVE_ROOT}/etc/g6-taxonomy-svc"
    cp "${REPO_ROOT}/ops/oracle/service-registry.sh" "${LIVE_ROOT}/lib/service-registry.sh"
    cp "${REPO_ROOT}/ops/oracle/services.psv" "${LIVE_ROOT}/lib/services.psv"
    cp "$SOURCE_ENGINE" "${LIVE_ROOT}/lib/deploy-g6-service.sh"
    sed -i \
      -e 's/^catalog-svc|false|/catalog-svc|true|/' \
      -e 's/^taxonomy-svc|false|/taxonomy-svc|true|/' \
      -e "s|/opt/g6-productos-ofertas|${LIVE_ROOT}/opt/g6-productos-ofertas|g" \
      -e "s|/var/lib/g6-productos-ofertas|${LIVE_ROOT}/var/lib/g6-productos-ofertas|g" \
      -e "s|/etc/g6-|${LIVE_ROOT}/etc/g6-|g" \
      "${LIVE_ROOT}/lib/service-registry.sh" "${LIVE_ROOT}/lib/services.psv"
    sed -i \
      -e "s|/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml|${LIVE_ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml|g" \
      -e "s|/opt/g6-productos-ofertas|${LIVE_ROOT}/opt/g6-productos-ofertas|g" \
      -e "s|/var/lib/g6-productos-ofertas|${LIVE_ROOT}/var/lib/g6-productos-ofertas|g" \
      -e "s|/etc/g6-|${LIVE_ROOT}/etc/g6-|g" \
      -e "s|g6-http|${RUNTIME_NETWORK}|g" \
      "${LIVE_ROOT}/lib/deploy-g6-service.sh"
    touch "${LIVE_ROOT}/opt/g6-productos-ofertas/shared/docker-compose.service.yml" \
      "${LIVE_ROOT}/etc/g6-catalog-svc/runtime.env" "${LIVE_ROOT}/etc/g6-taxonomy-svc/runtime.env"
    mkdir -p "${LIVE_ROOT}/opt/g6-productos-ofertas/shared"
    chmod +x "${LIVE_ROOT}/lib/deploy-g6-service.sh"
    result=0
    if printf '%s\n%s\n' 'simulation-only-user' 'simulation-only-token' |
      env SSH_ORIGINAL_COMMAND="service-deploy catalog-svc ${IMAGE_SHA}" \
        bash "${LIVE_ROOT}/lib/deploy-g6-service.sh" > "${TEMP_ROOT}/runtime-preflight.log" 2>&1; then
      result=0
    else
      result=$?
    fi
    [[ "$result" == 1 ]] || fail "preflight Docker real terminó inesperadamente: $(<"${TEMP_ROOT}/runtime-preflight.log")"
    grep -Fq 'la imagen actual no pertenece al servicio registrado' "${TEMP_ROOT}/runtime-preflight.log" ||
      fail "preflight Docker no superó la validación de aliases: $(<"${TEMP_ROOT}/runtime-preflight.log")"
    printf 'CORRECTO: preflight real aceptó ambos miembros; se detuvo luego en el gate de imagen antes de login/pull/up\n'
  fi
else
  [[ "$REQUIRE_DOCKER_RUNTIME" != true ]] ||
    fail 'Docker, Compose, daemon e inventory-svc:ci son obligatorios para validar aliases reales'
  printf 'NO EJECUTADO: Docker daemon e imagen inventory-svc:ci requeridos para verificar aliases runtime\n'
fi

printf 'Todas las simulaciones de despliegue genérico pasaron.\n'
