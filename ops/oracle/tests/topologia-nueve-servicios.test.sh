#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REGISTRY="$ROOT/ops/oracle/services.psv"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
command -v bash >/dev/null 2>&1 || fail 'bash requerido'

mapfile -t rows < <(awk -F'|' '$1 !~ /^#/ && NF {print}' "$REGISTRY")
[[ "${#rows[@]}" == 9 ]] || fail "se esperaban 9 filas; hay ${#rows[@]}"
[[ "$(head -n 1 "$REGISTRY")" == '#registry-version=2' ]] || fail 'registro distinto de v2'

declare -A services=() ports=() projects=() containers=() images=() state_dirs=() aliases=()
for row in "${rows[@]}"; do
  IFS='|' read -r service enabled port port_env _ _ image compose project _ container state_dir _ <<< "$row"
  [[ "$enabled" == true ]] || fail "$service no está habilitado en registro"
  [[ -z "${services[$service]:-}" && -z "${ports[$port]:-}" && -z "${projects[$project]:-}" && -z "${containers[$container]:-}" && -z "${images[$image]:-}" && -z "${state_dirs[$state_dir]:-}" ]] || fail "colisión en fila $service"
  services[$service]=1; ports[$port]=1; projects[$project]=1; containers[$container]=1; images[$image]=1; state_dirs[$state_dir]=1
  expected_alias="$service"
  aliases[$service]="$expected_alias"
  expected_port_env="${service^^}_PORT"
  [[ "$service" == api-gateway ]] && expected_port_env=API_GATEWAY_PORT
  expected_port_env="${expected_port_env//-/_}"
  [[ "$port" =~ ^[0-9]{4,5}$ && "$port_env" == "$expected_port_env" ]] || fail "puerto/env inválido para $service"
  [[ "$compose" == *docker-compose.gateway.yml || "$compose" == *docker-compose.service.yml || "$service" == inventory-svc ]] || fail "Compose no autorizado para $service"
done

expected='api-gateway:3000 bulk-svc:3008 catalog-svc:3001 combos-svc:3007 inventory-svc:3005 price-audit-svc:3003 pricing-svc:3002 promotions-svc:3004 taxonomy-svc:3006'
actual="$(awk -F'|' '$1 !~ /^#/ && NF {print $1 ":" $3}' "$REGISTRY" | sort | tr '\n' ' ' | sed 's/ $//')"
expected_sorted="$(printf '%s\n' $expected | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$actual" == "$expected_sorted" ]] || fail "servicios/puertos no corresponden: $actual"
if rg -n 'internal:[[:space:]]*true|g6-amqp|rabbitmq|caddy' \
  "$ROOT/ops/oracle/docker-compose.service.http.yml" \
  "$ROOT/ops/oracle/docker-compose.inventory.http.yml" \
  "$ROOT/ops/oracle/docker-compose.gateway.yml"; then
  fail 'overlay incluye una red o miembro fuera del alcance HTTP'
fi
[[ "$(rg -c 'name: g6-edge' "$ROOT/ops/oracle/docker-compose.gateway.yml")" == 1 ]] || fail 'g6-edge no está limitado al Compose de Gateway'
[[ "$(rg -c 'name: g6-http' "$ROOT/ops/oracle/docker-compose.service.http.yml")" == 1 ]] || fail 'overlay genérico no declara g6-http externa'
grep -Fq 'bridge local, `Internal=false`' "$ROOT/ops/oracle/INSTALACION_H4_NUEVE_SERVICIOS.md" || fail 'el preflight no exige g6-http bridge no-internal'
[[ "$(rg -c 'reverse_proxy g6-api-gateway:3000' "$ROOT/ops/oracle/Caddyfile")" == 2 ]] || fail 'Caddy depende de rutas/servicios individuales'
! rg -n 'docker-compose\.service\.http\.yml|docker-compose\.inventory\.http\.yml|Caddyfile|services\.psv' \
  "$ROOT/ops/oracle/deploy-g6-service.sh" | rg -n 'install|cp |mv |sed |tee ' || fail 'el despliegue intenta modificar infraestructura compartida'

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  for row in "${rows[@]}"; do
    IFS='|' read -r service _ port port_env _ _ image _ _ unit container _ _ <<< "$row"
    envfile="$TEMP_ROOT/$service.env"
    : > "$envfile"
    if [[ "$service" == inventory-svc ]]; then
      compose="$ROOT/docker-compose.inventory.yml"
      printf 'INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:%s\n' "$(printf 'a%.0s' {1..40})" > "$envfile"
      sed "s|/etc/g6-inventory/runtime.env|$envfile|" "$compose" > "$TEMP_ROOT/inventory.compose.yml"
      compose="$TEMP_ROOT/inventory.compose.yml"
      args=(--env-file "$envfile" --project-name g6-inventory --file "$compose")
      docker compose "${args[@]}" config --quiet >/dev/null || fail 'Compose legacy de Inventory inválido'
      docker compose "${args[@]}" --file "$ROOT/ops/oracle/docker-compose.inventory.http.yml" config --quiet >/dev/null || fail 'Compose legacy+overlay de Inventory inválido'
      docker compose "${args[@]}" --file "$ROOT/ops/oracle/docker-compose.inventory.http.yml" config >"$TEMP_ROOT/inventory.yml" || fail 'no se pudo renderizar Inventory'
      grep -Fq 'host_ip: 127.0.0.1' "$TEMP_ROOT/inventory.yml" || fail 'Inventory perdió loopback'
      grep -Fq 'published: "3005"' "$TEMP_ROOT/inventory.yml" || fail 'Inventory perdió el puerto 3005'
      grep -A8 -F 'g6-http:' "$TEMP_ROOT/inventory.yml" | grep -Fq 'inventory-svc' || fail 'alias HTTP de Inventory ausente'
      continue
    fi

    export G6_SERVICE_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/$service:$(printf 'a%.0s' {1..40})"
    export G6_SERVICE_CONTAINER="$container" G6_SERVICE_PORT="$port" G6_SERVICE_PORT_ENV="$port_env"
    export G6_SERVICE_IMAGE_NAME="$service" G6_SERVICE_ENV_FILE="$envfile"
    if [[ "$service" == api-gateway ]]; then compose="$ROOT/ops/oracle/docker-compose.gateway.yml"
    else compose="$ROOT/ops/oracle/docker-compose.service.yml"; fi
    docker compose --env-file "$envfile" --project-name "g6-$service" --file "$compose" config --quiet || fail "Compose inválido para $service"
    docker compose --env-file "$envfile" --project-name "g6-$service" --file "$compose" --file "$ROOT/ops/oracle/docker-compose.service.http.yml" config >"$TEMP_ROOT/$service.yml" || fail "overlay HTTP inválido para $service"
    grep -Fq 'host_ip: 127.0.0.1' "$TEMP_ROOT/$service.yml" || fail "$service no está ligado a loopback"
    grep -Fq "published: \"$port\"" "$TEMP_ROOT/$service.yml" || fail "$service publicó un puerto incorrecto"
    grep -A8 -F 'g6-http:' "$TEMP_ROOT/$service.yml" | grep -Fq "${aliases[$service]}" || fail "alias HTTP incorrecto para $service"
    if [[ "$service" == api-gateway ]]; then grep -A8 -F 'g6-edge:' "$TEMP_ROOT/$service.yml" | grep -Fq g6-api-gateway || fail 'Gateway perdió g6-edge'
    else grep -Fq 'g6-edge' "$TEMP_ROOT/$service.yml" && fail "$service conectado a g6-edge" || true; fi
  done
else
  printf 'NO EJECUTADO: docker compose no disponible; validaciones Compose omitidas\n'
fi

for f in "$ROOT/ops/oracle/deploy-g6-service.sh" "$ROOT/ops/oracle/service-registry.sh" "$ROOT/.github/workflows/cd-services-oracle.yml"; do
  rg -n '^[[:space:]]*(docker|docker-compose)[[:space:]].*(down[[:space:]]+-v|--remove-orphans|network[[:space:]]+prune)' "$f" && fail "acción global en procedimiento/CD: $f"
done

printf 'PASS: registro v2, nueve servicios, puertos/identidades únicas y topología aislada validada\n'
