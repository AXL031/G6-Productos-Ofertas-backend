#!/usr/bin/env bash
set -Eeuo pipefail

# Verifica en la VM de Azure:
# 1. Liveness (/health) y Readiness (/health/ready + readiness.js) con PostgreSQL real
# 2. Aislamiento de red (g6-edge y g6-http, loopback 127.0.0.1)
# 3. HTTPS público vía Caddy
# 4. Ensayo real de Rollback automático ante imagen fallida en taxonomy-svc

[[ $EUID -eq 0 ]] || { printf 'Ejecutar con sudo/root.\n' >&2; exit 1; }

if [[ -f /etc/g6-productos-ofertas/azure.conf ]]; then
  # shellcheck disable=SC1091
  source /etc/g6-productos-ofertas/azure.conf
fi

readonly REGISTRY_PREFIX="${G6_REGISTRY_PREFIX:-ghcr.io/axl031/g6-productos-ofertas-backend}"
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

echo "================================================================"
echo "3. Verificando HTTPS Público a través de Caddy (${DOMAIN})"
echo "================================================================"
if [[ "$DOMAIN" != "localhost" ]]; then
  curl --fail --silent --show-error "https://${DOMAIN}/health"
  echo ""
fi

echo "================================================================"
echo "4. Ensayo de Rollback Automático (taxonomy-svc)"
echo "================================================================"
ACTIVE_BEFORE="$(cat /var/lib/g6-productos-ofertas/taxonomy-svc/active-image)"
echo "Imagen activa antes del ensayo: ${ACTIVE_BEFORE}"

readonly BROKEN_SHA="000000000000000000000000000000000000dead"
readonly BROKEN_IMAGE="${REGISTRY_PREFIX}/taxonomy-svc:${BROKEN_SHA}"

docker build -t "$BROKEN_IMAGE" - <<'EOF'
FROM node:24.15.0-alpine
CMD ["node", "-e", "process.exit(1)"]
EOF

set +e
env SSH_ORIGINAL_COMMAND="service-deploy taxonomy-svc ${BROKEN_SHA}" \
  /usr/local/lib/g6-productos-ofertas/deploy-g6-service </dev/null
DEPLOY_RC=$?
set -e

docker rmi "$BROKEN_IMAGE" >/dev/null 2>&1 || true

if [[ "$DEPLOY_RC" -eq 0 ]]; then
  echo "FALLO: el despliegue de la imagen rota debía fallar y hacer rollback." >&2
  exit 1
fi

ACTIVE_AFTER="$(cat /var/lib/g6-productos-ofertas/taxonomy-svc/active-image)"
CONTAINER_IMAGE="$(docker inspect --format '{{.Config.Image}}' g6-taxonomy-svc)"
HEALTH_AFTER="$(docker inspect --format '{{.State.Health.Status}}' g6-taxonomy-svc)"

echo "Imagen activa tras rollback:     ${ACTIVE_AFTER}"
echo "Imagen en contenedor:            ${CONTAINER_IMAGE}"
echo "Estado Docker health:            ${HEALTH_AFTER}"

[[ "$ACTIVE_AFTER" == "$ACTIVE_BEFORE" && "$CONTAINER_IMAGE" == "$ACTIVE_BEFORE" && "$HEALTH_AFTER" == "healthy" ]] || {
  echo "FALLO: el estado posterior al rollback no coincide con la imagen original saludable." >&2
  exit 1
}

echo "PASS: Rollback automático verificado exitosamente."
