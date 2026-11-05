#!/usr/bin/env bash
set -Eeuo pipefail

# Verifica en la VM de Azure:
# 1. Liveness (/health) y Readiness (/health/ready + readiness.js) con PostgreSQL real
# 2. Aislamiento de red (g6-edge y g6-http, loopback 127.0.0.1)
# 3. HTTPS público vía Caddy
# Este script es de solo lectura. El ensayo destructivo de rollback se realiza
# en infraestructura desechable, nunca implícitamente contra la VM.

[[ $EUID -eq 0 ]] || { printf 'Ejecutar con sudo/root.\n' >&2; exit 1; }

if [[ -f /etc/g6-productos-ofertas/azure.conf ]]; then
  # shellcheck disable=SC1091
  source /etc/g6-productos-ofertas/azure.conf
fi

readonly DOMAIN="${G6_PUBLIC_DOMAIN:-localhost}"

echo "================================================================"
echo "1. Verificando Liveness y Readiness en Loopback (127.0.0.1)"
echo "================================================================"
for port in 3000 3001 3006; do
  printf 'Liveness 127.0.0.1:%s/health -> ' "$port"
  curl --fail --silent --show-error "http://127.0.0.1:${port}/health"
  echo ""
done

printf 'Readiness taxonomy-svc (127.0.0.1:3006/health/ready) -> '
curl --fail --silent --show-error http://127.0.0.1:3006/health/ready
echo ""

printf 'Readiness catalog-svc (127.0.0.1:3001/health/ready) -> '
curl --fail --silent --show-error http://127.0.0.1:3001/health/ready
echo ""

printf 'Readiness api-gateway (bundle readiness.js) -> '
docker exec g6-api-gateway node dist/apps/api-gateway/readiness.js

echo "================================================================"
echo "2. Verificando Redes Privadas (g6-edge y g6-http)"
echo "================================================================"
echo "Miembros de g6-edge (esperado: solo g6-caddy y g6-api-gateway):"
docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' g6-edge
echo ""
echo "Miembros de g6-http (esperado: g6-api-gateway, g6-catalog-svc, g6-taxonomy-svc):"
docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' g6-http
echo ""
edge_members="$(docker network inspect --format '{{range .Containers}}{{println .Name}}{{end}}' g6-edge | sed '/^$/d' | sort)"
http_members="$(docker network inspect --format '{{range .Containers}}{{println .Name}}{{end}}' g6-http | sed '/^$/d' | sort)"
[[ "$edge_members" == $'g6-api-gateway\ng6-caddy' &&
   "$http_members" == $'g6-api-gateway\ng6-catalog-svc\ng6-taxonomy-svc' ]] || {
  printf 'Membresía Docker inesperada; requiere revisión.\n' >&2; exit 1;
}
for service in api-gateway catalog-svc taxonomy-svc; do
  bindings="$(docker port "g6-${service}")"
  [[ -n "$bindings" ]] && ! grep -Ev '^[0-9]+/tcp -> 127\.0\.0\.1:[0-9]+$' <<< "$bindings" || {
    printf 'Publicación de puerto inesperada en %s.\n' "$service" >&2; exit 1;
  }
done

echo "================================================================"
echo "3. Verificando HTTPS Público a través de Caddy (${DOMAIN})"
echo "================================================================"
if [[ "$DOMAIN" != "localhost" ]]; then
  curl --fail --silent --show-error "https://${DOMAIN}/health"
  echo ""
fi

for service in taxonomy-svc catalog-svc api-gateway; do
  image="$(docker inspect --format '{{.Config.Image}}' "g6-${service}")"
  [[ "$image" =~ ^ghcr.io/taller-sw-web/g6-productos-ofertas-backend/${service}@sha256:[0-9a-f]{64}$ ]] || {
    printf 'Imagen no fijada a digest oficial: %s\n' "$service" >&2; exit 1;
  }
done
echo 'PASS: health/readiness y referencias oficiales verificadas.'
echo 'NO EJECUTADO: rollback remoto ni autenticación funcional. Ejecutar ensayos aislados y adjuntar evidencia independiente.'
