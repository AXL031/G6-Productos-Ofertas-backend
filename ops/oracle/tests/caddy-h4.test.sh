#!/usr/bin/env bash
set -Eeuo pipefail

# Dependencies: bash, docker (daemon access), node, curl, grep, awk, sed, mktemp, cat, head, sleep, rm.
# Official Caddy and Node images must already be present; CI pulls them explicitly.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CADDYFILE="$ROOT/ops/oracle/Caddyfile"
CADDY_IMAGE="${CADDY_TEST_IMAGE:-caddy:2.11.6-alpine}"
NODE_IMAGE="${CADDY_MOCK_IMAGE:-node:24-alpine}"
for tool in bash docker node curl grep awk sed mktemp cat head sleep rm; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'FAIL: dependencia requerida ausente: %s\n' "$tool" >&2; exit 1; }
done
docker_exec() { MSYS_NO_PATHCONV=1 docker "$@"; }
docker_exec info >/dev/null 2>&1 || { printf 'FAIL: daemon Docker no disponible\n' >&2; exit 1; }
docker_exec image inspect "$CADDY_IMAGE" >/dev/null 2>&1 || { printf 'FAIL: imagen oficial Caddy no disponible: %s\n' "$CADDY_IMAGE" >&2; exit 1; }
docker_exec image inspect "$NODE_IMAGE" >/dev/null 2>&1 || { printf 'FAIL: imagen oficial Node mock no disponible: %s\n' "$NODE_IMAGE" >&2; exit 1; }

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
grep -Eq '^[[:space:]]*admin off[[:space:]]*$' "$CADDYFILE" || fail 'Caddy admin debe estar deshabilitado'
grep -Eq 'g6-productos-ofertas\.duckdns\.org' "$CADDYFILE" || fail 'dominio productivo ausente del candidato'
[[ "$(grep -Ec 'reverse_proxy g6-api-gateway:3000' "$CADDYFILE")" == 2 ]] || fail 'upstream productivo debe conservar dos referencias a Gateway'
if grep -En 'handle_path|request_body|read_timeout|write_timeout|GATEWAY_DEMO_NO_AUTH_ENABLED|G6_READ_ONLY_DEMO_ENABLED' "$CADDYFILE"; then
  fail 'Caddy incluye rewrite, límites globales o bypass de autenticación'
fi
if grep -En 'reverse_proxy[[:space:]]+(catalog-svc|pricing-svc|price-audit-svc|promotions-svc|inventory-svc|taxonomy-svc|combos-svc|bulk-svc)' "$CADDYFILE"; then
  fail 'Caddy no puede dirigir tráfico directamente a servicios de negocio'
fi

TEMP_ROOT="$(mktemp -d)"
DOCKER_TEMP_ROOT="$TEMP_ROOT"
if [[ -n "${MSYSTEM:-}" ]] && command -v cygpath >/dev/null 2>&1; then
  DOCKER_TEMP_ROOT="$(cygpath -m "$TEMP_ROOT")"
fi
MOCK_CONTAINER="caddy-h4-mock-$$-$RANDOM"
CADDY_CONTAINER="caddy-h4-test-$$-$RANDOM"
CADDY_STARTED=0
MOCK_STARTED=0
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if (( CADDY_STARTED )); then
    docker_exec rm --force "$CADDY_CONTAINER" >/dev/null 2>&1 || {
      printf 'FAIL: no se pudo limpiar el contenedor temporal %s\n' "$CADDY_CONTAINER" >&2
      rc=1
    }
  fi
  if (( MOCK_STARTED )); then
    docker_exec rm --force "$MOCK_CONTAINER" >/dev/null 2>&1 || {
      printf 'FAIL: no se pudo limpiar el mock temporal %s\n' "$MOCK_CONTAINER" >&2
      rc=1
    }
  fi
  if [[ -n "${TEMP_ROOT:-}" && -d "$TEMP_ROOT" ]]; then rm -rf -- "$TEMP_ROOT"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

reserve_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
UPSTREAM_PORT="$(reserve_port)"
PROXY_PORT="$(reserve_port)"
[[ "$UPSTREAM_PORT" != "$PROXY_PORT" ]] || fail 'no se pudieron reservar puertos distintos'

cat >"$TEMP_ROOT/upstream.cjs" <<'NODE'
const http = require('node:http');
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/__mock_ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"service":"caddy-h4-mock","ready":true}');
      return;
    }
    const status = Number(req.headers['x-test-status'] || 200);
    const responseBody = `mock-status-${status};method=${req.method};url=${req.url};body=${body}`;
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'x-mock-response': 'preserved' };
    if (status === 401) headers['www-authenticate'] = 'Bearer realm="mock", error="invalid_token"';
    if (status === 403) headers['x-authz-result'] = 'denied-by-mock';
    res.writeHead(status, headers);
    res.end(responseBody);
  });
});
server.listen(Number(process.env.UPSTREAM_PORT), '0.0.0.0');
NODE

# Only this disposable copy changes. Both production upstreams are redirected to the local mock.
sed -e "s|g6-productos-ofertas.duckdns.org {|http://127.0.0.1:${PROXY_PORT} {|" \
    -e "s|g6-api-gateway:3000|127.0.0.1:${UPSTREAM_PORT}|g" \
    "$CADDYFILE" >"$TEMP_ROOT/Caddyfile"
[[ "$(grep -Ec "reverse_proxy 127.0.0.1:${UPSTREAM_PORT}" "$TEMP_ROOT/Caddyfile")" == 2 ]] || fail 'copia temporal no sustituyó ambos upstreams'
[[ "$(grep -Ec 'g6-api-gateway:3000' "$CADDYFILE")" == 2 ]] || fail 'Caddyfile productivo fue alterado'

wait_http_valid() {
  local url="$1" expected="$2" label="$3" code body
  for _ in {1..80}; do
    if code="$(curl --silent --show-error --max-time 1 --output "$TEMP_ROOT/wait.body" --write-out '%{http_code}' "$url" 2>/dev/null)"; then
      body="$(cat "$TEMP_ROOT/wait.body")"
      if [[ "$code" == "$expected" && "$body" == "$label" ]]; then return 0; fi
    fi
    sleep 0.1
  done
  printf 'FAIL: %s no produjo respuesta HTTP válida (último status=%s body=%s)\n' "$label" "${code:-none}" "${body:-none}" >&2
  return 1
}
docker_exec run --detach --rm --name "$MOCK_CONTAINER" \
  --publish "127.0.0.1:${UPSTREAM_PORT}:${UPSTREAM_PORT}" \
  --publish "127.0.0.1:${PROXY_PORT}:${PROXY_PORT}" \
  --volume "$DOCKER_TEMP_ROOT:/test:ro" --env "UPSTREAM_PORT=$UPSTREAM_PORT" \
  "$NODE_IMAGE" node /test/upstream.cjs >"$TEMP_ROOT/mock-id" || fail 'no inició el mock HTTP temporal'
MOCK_STARTED=1
wait_http_valid "http://127.0.0.1:${UPSTREAM_PORT}/__mock_ready" 200 '{"service":"caddy-h4-mock","ready":true}' 'mock-ready' || {
  docker_exec logs "$MOCK_CONTAINER" >&2 2>&1 || true
  fail 'el mock no quedó disponible con respuesta HTTP válida'
}

docker_exec run --rm --volume "$DOCKER_TEMP_ROOT:/test:ro" "$CADDY_IMAGE" \
  caddy validate --config /test/Caddyfile --adapter caddyfile >"$TEMP_ROOT/validate.log" 2>&1 || {
    cat "$TEMP_ROOT/validate.log" >&2; fail 'caddy validate falló en la imagen oficial'
  }
docker_exec run --detach --rm --name "$CADDY_CONTAINER" --network "container:$MOCK_CONTAINER" \
  --volume "$DOCKER_TEMP_ROOT:/test:ro" "$CADDY_IMAGE" \
  caddy run --config /test/Caddyfile --adapter caddyfile >"$TEMP_ROOT/container-id" || fail 'no inició Caddy real'
CADDY_STARTED=1

wait_proxy() {
  local code body
  for _ in {1..100}; do
    if code="$(curl --silent --show-error --max-time 1 --output "$TEMP_ROOT/proxy-wait.body" --write-out '%{http_code}' "http://127.0.0.1:${PROXY_PORT}/health" 2>/dev/null)"; then
      body="$(cat "$TEMP_ROOT/proxy-wait.body")"
      if [[ "$code" == 200 && "$body" == 'mock-status-200;method=GET;url=/health;body=' ]]; then return 0; fi
    fi
    if [[ "$(docker_exec inspect --format '{{.State.Running}}' "$CADDY_CONTAINER" 2>/dev/null || true)" != true ]]; then break; fi
    sleep 0.1
  done
  docker_exec logs "$CADDY_CONTAINER" >&2 2>&1 || true
  fail "Caddy no quedó disponible con respuesta HTTP válida (status=${code:-none}, body=${body:-none})"
}
wait_proxy

assert_headers() {
  local headers="$1" auth="$2"
  [[ "$(grep -Eci '^X-Content-Type-Options: nosniff$' "$headers")" == 1 ]] || fail 'X-Content-Type-Options no coincide exactamente'
  [[ "$(grep -Eci '^X-Frame-Options: DENY$' "$headers")" == 1 ]] || fail 'X-Frame-Options no coincide exactamente'
  [[ "$(grep -Eci '^Referrer-Policy: no-referrer$' "$headers")" == 1 ]] || fail 'Referrer-Policy no coincide exactamente'
  ! grep -Eqi '^Server:' "$headers" || fail 'se filtró el encabezado Server'
  if [[ "$auth" == preserve ]]; then
    [[ "$(grep -Eci '^Content-Type: text/plain; charset=utf-8$' "$headers")" == 1 ]] || fail 'Caddy alteró Content-Type del upstream'
    [[ "$(grep -Eci '^X-Mock-Response: preserved$' "$headers")" == 1 ]] || fail 'respuesta upstream alterada: falta encabezado X-Mock-Response'
  fi
}
request() {
  local method="$1" path="$2" expected_status="$3" expected_body="$4" auth=preserve
  shift 4
  if [[ "${1:-}" == preserve || "${1:-}" == fallback ]]; then auth="$1"; shift; fi
  local code
  code="$(curl --silent --show-error --max-time 3 --request "$method" "$@" \
    --dump-header "$TEMP_ROOT/headers" --output "$TEMP_ROOT/body" --write-out '%{http_code}' \
    "http://127.0.0.1:${PROXY_PORT}${path}")" || fail "curl falló para $method $path"
  awk '{ sub(/\r$/, ""); print }' "$TEMP_ROOT/headers" > "$TEMP_ROOT/headers.normalized"
  [[ "$code" == "$expected_status" ]] || fail "$method $path status=$code esperado=$expected_status"
  [[ "$(cat "$TEMP_ROOT/body")" == "$expected_body" ]] || fail "$method $path cuerpo distinto: $(cat "$TEMP_ROOT/body")"
  assert_headers "$TEMP_ROOT/headers.normalized" "$auth"
}

request GET /health 200 'mock-status-200;method=GET;url=/health;body='
for path in \
  /api/v1/categorias /api/v1/marcas '/api/v1/productos?pagina=2&limite=25' \
  /api/v1/productos/550e8400-e29b-41d4-a716-446655440000 /api/v1/productos/por-slug/cafe-molido \
  /api/v1/precios /api/v1/inventario /api/v1/promociones /api/v1/combos \
  /api/v1/carga-masiva/productos/plantilla /api/v1/carga-masiva/productos/importaciones \
  /api/v1/auditoria-precios /api/v1/auditoria-precios/exportaciones; do
  expected="mock-status-200;method=GET;url=${path};body="
  request GET "$path" 200 "$expected"
done

# These methods only assert transport fidelity through the proxy; no business authorization is inferred.
request POST '/api/v1/productos?modo=mock' 200 'mock-status-200;method=POST;url=/api/v1/productos?modo=mock;body={"fixture":true}' preserve --data-binary '{"fixture":true}'
request PATCH '/api/v1/productos/1?modo=mock' 200 'mock-status-200;method=PATCH;url=/api/v1/productos/1?modo=mock;body={"fixture":true}' preserve --data-binary '{"fixture":true}'
request DELETE '/api/v1/productos/1?modo=mock' 200 'mock-status-200;method=DELETE;url=/api/v1/productos/1?modo=mock;body='

for status in 401 403 404 503; do
  expected="mock-status-${status};method=GET;url=/api/v1/status;body="
  request GET /api/v1/status "$status" "$expected" preserve -H "X-Test-Status: $status"
  if [[ "$status" == 401 ]]; then
    [[ "$(grep -Eci '^WWW-Authenticate: Bearer realm="mock", error="invalid_token"$' "$TEMP_ROOT/headers.normalized")" == 1 ]] || fail 'Caddy alteró WWW-Authenticate del 401'
  fi
  if [[ "$status" == 403 ]]; then
    [[ "$(grep -Eci '^X-Authz-Result: denied-by-mock$' "$TEMP_ROOT/headers.normalized")" == 1 ]] || fail 'Caddy alteró la respuesta 403 del upstream'
  fi
done

for path in /ruta-inexistente /metrics /admin; do
  request GET "$path" 404 '{"codigo":"RUTA_NO_PUBLICADA"}' fallback
  ! grep -Eqi '^X-Mock-Response:' "$TEMP_ROOT/headers.normalized" || fail "fallback $path alcanzó el upstream"
done

printf 'PASS: Caddy %s real validado y proxy HTTP local; auth no validada; POST/PATCH/DELETE solo prueban transporte\n' "$CADDY_IMAGE"
