#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CADDYFILE="$ROOT/ops/oracle/Caddyfile"
grep -Fq $'admin off' "$CADDYFILE" || { printf 'FAIL: Caddy admin debe estar deshabilitado\n' >&2; exit 1; }
grep -Fq 'g6-productos-ofertas.duckdns.org' "$CADDYFILE" || { printf 'FAIL: dominio Oracle incorrecto\n' >&2; exit 1; }
[[ "$(rg -c 'reverse_proxy g6-api-gateway:3000' "$CADDYFILE")" == 2 ]] || { printf 'FAIL: /health y /api/v1/* deben usar el Gateway\n' >&2; exit 1; }
if rg -n 'handle_path|request_body|read_timeout|write_timeout|GATEWAY_DEMO_NO_AUTH_ENABLED|G6_READ_ONLY_DEMO_ENABLED' "$CADDYFILE"; then
  printf 'FAIL: Caddy incluye rewrite, límites globales o bypass de autenticación\n' >&2
  exit 1
fi
for tool in caddy node curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'NO EJECUTADO: validación/simulación Caddy requiere %s; aserciones estáticas aprobadas\n' "$tool"
    exit 77
  }
done

TEMP_ROOT="$(mktemp -d)"
CADDY_PID=''
UPSTREAM_PID=''
cleanup() {
  [[ -z "$CADDY_PID" ]] || kill "$CADDY_PID" 2>/dev/null || true
  [[ -z "$UPSTREAM_PID" ]] || kill "$UPSTREAM_PID" 2>/dev/null || true
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT

port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
UPSTREAM_PORT="$(port)"
PROXY_PORT="$(port)"

cat >"$TEMP_ROOT/upstream.mjs" <<'NODE'
import http from 'node:http';
const server = http.createServer((req, res) => {
  const status = Number(req.headers['x-test-status'] || 200);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-seen-method', req.method);
  res.end(JSON.stringify({ method: req.method, url: req.url }));
});
server.listen(Number(process.env.UPSTREAM_PORT), '127.0.0.1');
NODE
UPSTREAM_PORT="$UPSTREAM_PORT" node "$TEMP_ROOT/upstream.mjs" >"$TEMP_ROOT/upstream.log" 2>&1 &
UPSTREAM_PID=$!

# Adapt only the listen address for a local HTTP-only integration simulation.
sed "s|g6-productos-ofertas.duckdns.org {|http://127.0.0.1:${PROXY_PORT} {|" "$CADDYFILE" >"$TEMP_ROOT/Caddyfile"
caddy validate --config "$TEMP_ROOT/Caddyfile" --adapter caddyfile
caddy run --config "$TEMP_ROOT/Caddyfile" --adapter caddyfile >"$TEMP_ROOT/caddy.log" 2>&1 &
CADDY_PID=$!

wait_http() {
  for _ in {1..50}; do
    if curl --silent --output /dev/null "http://127.0.0.1:${PROXY_PORT}/health"; then return 0; fi
    sleep 0.1
  done
  cat "$TEMP_ROOT/caddy.log" >&2
  return 1
}
wait_http

request() {
  local method="$1" path="$2" expected_status="$3" expected_url="$4"
  local status
  status="$(curl --silent --show-error --request "$method" --dump-header "$TEMP_ROOT/headers" --output "$TEMP_ROOT/body" --write-out '%{http_code}' "http://127.0.0.1:${PROXY_PORT}${path}")"
  [[ "$status" == "$expected_status" ]] || { printf 'FAIL: %s %s status=%s esperado=%s\n' "$method" "$path" "$status" "$expected_status" >&2; return 1; }
  if [[ -n "$expected_url" ]]; then
    grep -Fq "\"url\":\"$expected_url\"" "$TEMP_ROOT/body" || { cat "$TEMP_ROOT/body" >&2; return 1; }
    grep -Fq "\"method\":\"$method\"" "$TEMP_ROOT/body" || { cat "$TEMP_ROOT/body" >&2; return 1; }
  fi
  grep -Eiq '^X-Content-Type-Options: nosniff' "$TEMP_ROOT/headers" || return 1
  grep -Eiq '^X-Frame-Options: DENY' "$TEMP_ROOT/headers" || return 1
  grep -Eiq '^Referrer-Policy: no-referrer' "$TEMP_ROOT/headers" || return 1
  ! grep -Eiq '^Server:' "$TEMP_ROOT/headers" || return 1
}

request GET /health 200 /health
for path in \
  /api/v1/categorias \
  /api/v1/marcas \
  '/api/v1/productos?pagina=2&limite=25' \
  /api/v1/productos/550e8400-e29b-41d4-a716-446655440000 \
  /api/v1/productos/por-slug/cafe-molido \
  /api/v1/precios /api/v1/inventario /api/v1/promociones /api/v1/combos \
  /api/v1/carga-masiva/productos/plantilla \
  /api/v1/carga-masiva/productos/importaciones \
  /api/v1/auditoria-precios \
  /api/v1/auditoria-precios/exportaciones; do
  request GET "$path" 200 "$path"
done

for method in POST PATCH DELETE; do
  request "$method" /api/v1/productos 200 /api/v1/productos
done

for status in 401 403 404 503; do
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' -H "X-Test-Status: $status" "http://127.0.0.1:${PROXY_PORT}/api/v1/status")"
  [[ "$code" == "$status" ]] || { printf 'FAIL: upstream %s quedó como %s\n' "$status" "$code" >&2; exit 1; }
done

for path in /ruta-inexistente /metrics /admin; do
  code="$(curl --silent --show-error --output "$TEMP_ROOT/rejected" --write-out '%{http_code}' "http://127.0.0.1:${PROXY_PORT}${path}")"
  [[ "$code" == 404 ]] || { printf 'FAIL: %s respondió %s, se esperaba 404\n' "$path" "$code" >&2; exit 1; }
  grep -q 'RUTA_NO_PUBLICADA' "$TEMP_ROOT/rejected" || { printf 'FAIL: cuerpo no contractual para %s\n' "$path" >&2; exit 1; }
done

if rg -n 'reverse_proxy\s+(catalog-svc|pricing-svc|price-audit-svc|promotions-svc|inventory-svc|taxonomy-svc|combos-svc|bulk-svc)' "$CADDYFILE"; then
  printf 'FAIL: Caddy no puede dirigir tráfico directamente a servicios de negocio\n' >&2
  exit 1
fi
printf 'PASS: simulación local Caddy→upstream HTTP; no valida JWT ni autenticación real\n'
