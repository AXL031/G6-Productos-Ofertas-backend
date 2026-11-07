#!/usr/bin/env bash
set -Eeuo pipefail

# Dependencies: bash, awk, docker Compose v2, jq, sed, sort, mktemp, head, tr, grep, rm.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REGISTRY="$ROOT/ops/oracle/services.psv"
TEMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf -- "$TEMP_ROOT"; }
trap cleanup EXIT INT TERM
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
host_path() {
  if [[ -n "${MSYSTEM:-}" ]] && command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
for tool in bash awk docker jq sed sort mktemp head tr grep rm; do
  command -v "$tool" >/dev/null 2>&1 || fail "dependencia requerida ausente: $tool"
done

mapfile -t rows < <(awk -F'|' '$1 !~ /^#/ && NF {print}' "$REGISTRY")
[[ "${#rows[@]}" == 9 ]] || fail "Registro: se esperaban exactamente nueve filas; hay ${#rows[@]}"
[[ "$(head -n 1 "$REGISTRY")" == '#registry-version=2' ]] || fail 'registro distinto de v2'

declare -A services=() ports=() projects=() containers=() images=() state_dirs=() aliases=()
for row in "${rows[@]}"; do
  IFS='|' read -r service enabled port port_env _ _ image compose project _ container state_dir _ <<< "$row"
  [[ "$enabled" == true ]] || fail "$service no está habilitado en registro"
  [[ -z "${services[$service]:-}" && -z "${ports[$port]:-}" && -z "${projects[$project]:-}" && -z "${containers[$container]:-}" && -z "${images[$image]:-}" && -z "${state_dirs[$state_dir]:-}" ]] || fail "colisión de identidad/puerto/proyecto/imagen/state en $service"
  services[$service]=1; ports[$port]=1; projects[$project]=1; containers[$container]=1; images[$image]=1; state_dirs[$state_dir]=1
  aliases[$service]="$service"
  expected_port_env="${service^^}_PORT"
  [[ "$service" == api-gateway ]] && expected_port_env=API_GATEWAY_PORT
  expected_port_env="${expected_port_env//-/_}"
  [[ "$port" =~ ^[0-9]{4,5}$ && "$port_env" == "$expected_port_env" ]] || fail "puerto/env inválido para $service"
  [[ "$compose" == *docker-compose.gateway.yml || "$compose" == *docker-compose.service.yml || "$service" == inventory-svc ]] || fail "Compose no autorizado para $service"
  if [[ "$service" == inventory-svc ]]; then
    [[ "$port" == 3005 && "$compose" == *docker-compose.inventory.yml && "$project" == g6-inventory && "$container" == g6-inventory-svc && "$state_dir" == /var/lib/g6-inventory ]] || fail 'Inventory dejó de conservar Compose/proyecto/puerto/estado históricos'
  fi
done
expected='api-gateway:3000 bulk-svc:3008 catalog-svc:3001 combos-svc:3007 inventory-svc:3005 price-audit-svc:3003 pricing-svc:3002 promotions-svc:3004 taxonomy-svc:3006'
actual="$(awk -F'|' '$1 !~ /^#/ && NF {print $1 ":" $3}' "$REGISTRY" | sort | tr '\n' ' ' | sed 's/ $//')"
expected_sorted="$(printf '%s\n' $expected | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$actual" == "$expected_sorted" ]] || fail "identidades/puertos del registro incorrectos: $actual"

# Static assertions are reported separately from Compose rendering.
grep -En 'internal:[[:space:]]*true|g6-amqp|rabbitmq|caddy' \
  "$ROOT/ops/oracle/docker-compose.service.http.yml" \
  "$ROOT/ops/oracle/docker-compose.inventory.http.yml" \
  "$ROOT/ops/oracle/docker-compose.gateway.yml" && fail 'Compose HTTP incluye una red o miembro fuera del alcance HTTP'
[[ "$(grep -Ec 'name: g6-edge' "$ROOT/ops/oracle/docker-compose.gateway.yml")" == 1 ]] || fail 'g6-edge no está limitado al Compose de Gateway'
[[ "$(grep -Ec 'name: g6-http' "$ROOT/ops/oracle/docker-compose.service.http.yml")" == 1 ]] || fail 'overlay genérico no declara g6-http externa'
grep -En 'g6-http' "$ROOT"/ops/oracle/*rabbit* "$ROOT"/ops/oracle/*amqp* 2>/dev/null && fail 'manifiesto RabbitMQ/AMQP declara g6-http'
grep -Fq 'publicaciones solo en 127.0.0.1' "$ROOT/ops/oracle/INSTALACION_H4_NUEVE_SERVICIOS.md" || fail 'la guía no exige puertos loopback'
[[ "$(grep -Ec 'reverse_proxy g6-api-gateway:3000' "$ROOT/ops/oracle/Caddyfile")" == 2 ]] || fail 'Caddy depende de rutas/servicios individuales'
! grep -En 'docker-compose\.service\.http\.yml|docker-compose\.inventory\.http\.yml|Caddyfile|services\.psv' "$ROOT/ops/oracle/deploy-g6-service.sh" | grep -En 'install|cp |mv |sed |tee ' || fail 'el despliegue intenta modificar infraestructura compartida'
for f in "$ROOT/ops/oracle/deploy-g6-service.sh" "$ROOT/ops/oracle/service-registry.sh" "$ROOT/.github/workflows/cd-services-oracle.yml"; do
  grep -En '^[[:space:]]*(docker|docker-compose)[[:space:]].*(down[[:space:]]+-v|--remove-orphans|network[[:space:]]+prune)' "$f" && fail "acción global en procedimiento/CD: $f"
done
printf 'PASS ESTÁTICO: registro v2, nueve identidades/puertos únicos, red HTTP aislada y sin RabbitMQ en g6-http\n'

if ! docker compose version >/dev/null 2>&1; then
  if [[ "${G6_REQUIRE_DOCKER_COMPOSE:-false}" == true ]]; then fail 'Compose obligatorio para este job CI, pero no está disponible'; fi
  printf 'NO_EJECUTADO COMPOSE: Docker Compose v2 no disponible; CI debe fijar G6_REQUIRE_DOCKER_COMPOSE=true\n'
  exit 0
fi

export SHA_FIXTURE="$(printf 'a%.0s' {1..40})"
assert_ports_loopback() {
  local json="$1" expected_port="$2" label="$3"
  jq -e --arg expected "$expected_port" '
    ([.services[] | .ports // [] | .[]] as $ports |
      ($ports | length) == 1 and
      all($ports[]; .host_ip == "127.0.0.1") and
      (($ports[0].target | tostring) == $expected) and
      (($ports[0].published | tostring) == $expected))
  ' <<<"$json" >/dev/null || fail "$label tiene puerto adicional, público o distinto de $expected_port"
}
assert_alias() {
  local json="$1" network="$2" alias="$3" label="$4"
  jq -e --arg network "$network" --arg alias "$alias" '
    (.services | length) == 1 and
    ([.services[] | .networks[$network].aliases // [] | .[]] == [$alias])
  ' <<<"$json" >/dev/null || fail "$label alias canónico $network/$alias ausente o no único"
}

for row in "${rows[@]}"; do
  IFS='|' read -r service _ port port_env _ _ image _ project unit container _ _ <<< "$row"
  envfile="$TEMP_ROOT/$service.env"
  : >"$envfile"
  if [[ "$service" == inventory-svc ]]; then
    compose="$TEMP_ROOT/inventory.compose.yml"
    printf 'INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:%s\n' "$SHA_FIXTURE" >"$envfile"
    sed "s|/etc/g6-inventory/runtime.env|$(host_path "$envfile")|" "$ROOT/docker-compose.inventory.yml" >"$compose"
    overlay="$ROOT/ops/oracle/docker-compose.inventory.http.yml"
    args=(--env-file "$envfile" --project-name g6-inventory --file "$compose")
    base_json="$(docker compose "${args[@]}" config --format json)" || fail 'Compose histórico de Inventory inválido'
    combined_json="$(docker compose "${args[@]}" --file "$overlay" config --format json)" || fail 'Inventory con overlay inválido'
    [[ "$(jq -r '.name' <<<"$combined_json")" == g6-inventory ]] || fail 'proyecto histórico Inventory cambió'
    [[ "$(jq -r '.services | keys | join(",")' <<<"$combined_json")" == inventory-svc ]] || fail 'servicio histórico Inventory cambió'
    assert_ports_loopback "$base_json" 3005 'Inventory base'
    assert_ports_loopback "$combined_json" 3005 'Inventory HTTP'
    jq -e '.services["inventory-svc"].networks["g6-http"].aliases == ["inventory-svc"]' <<<"$combined_json" >/dev/null || fail 'Inventory perdió alias histórico g6-http'
    jq -e '(.services["inventory-svc"].networks | keys | sort) == ["default", "g6-http"]' <<<"$combined_json" >/dev/null || fail 'Inventory conectado a redes no autorizadas'
    jq -e '.services["inventory-svc"].ports[0].target == 3005' <<<"$combined_json" >/dev/null || fail 'Inventory perdió puerto interno 3005'
    continue
  fi

  export G6_SERVICE_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/$service:$SHA_FIXTURE"
  export G6_SERVICE_CONTAINER="$container" G6_SERVICE_PORT="$port" G6_SERVICE_PORT_ENV="$port_env"
  export G6_SERVICE_IMAGE_NAME="$service" G6_SERVICE_ENV_FILE="$envfile"
  if [[ "$service" == api-gateway ]]; then base="$ROOT/ops/oracle/docker-compose.gateway.yml"; else base="$ROOT/ops/oracle/docker-compose.service.yml"; fi
  base_json="$(docker compose --env-file "$envfile" --project-name "$project" --file "$base" config --format json)" || fail "Compose base inválido para $service"
  combined_json="$(docker compose --env-file "$envfile" --project-name "$project" --file "$base" --file "$ROOT/ops/oracle/docker-compose.service.http.yml" config --format json)" || fail "Compose HTTP inválido para $service"
  [[ "$(jq -r '.name' <<<"$combined_json")" == "$project" ]] || fail "$service proyecto Compose distinto al registro"
  [[ "$(jq -r '.services | keys | join(",")' <<<"$combined_json")" == service ]] || fail "$service cambió clave canónica Compose"
  assert_ports_loopback "$base_json" "$port" "$service base"
  assert_ports_loopback "$combined_json" "$port" "$service overlay"
  if [[ "$service" == api-gateway ]]; then
    assert_alias "$combined_json" g6-edge g6-api-gateway Gateway
    jq -e '.services.service.networks["g6-http"].aliases == ["api-gateway"]' <<<"$combined_json" >/dev/null || fail 'alias g6-http del Gateway no es canónico'
    jq -e '(.services.service.networks | keys | sort) == ["default", "g6-edge", "g6-http"]' <<<"$combined_json" >/dev/null || fail 'Gateway conectado a redes no autorizadas'
  else
    jq -e '(.services.service.networks | has("g6-edge")) | not' <<<"$combined_json" >/dev/null || fail "$service es otro servicio G6 conectado a g6-edge"
    jq -e '(.services.service.networks | keys | sort) == ["default", "g6-http"]' <<<"$combined_json" >/dev/null || fail "$service conectado a redes no autorizadas"
    jq -e --arg alias "$service" '.services.service.networks["g6-http"].aliases == [$alias]' <<<"$combined_json" >/dev/null || fail "$service no tiene alias canónico único en g6-http"
  fi
done

printf 'PASS COMPOSE: nueve configuraciones --format json validadas; puertos solo loopback, aliases y redes canónicas; sin crear redes ni arrancar servicios\n'
