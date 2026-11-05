#!/usr/bin/env bash
set -Eeuo pipefail

# Compila las imágenes Docker inmutables por SHA de los 3 componentes
# (taxonomy-svc, catalog-svc, api-gateway) y las despliega en orden de dependencia
# usando /usr/local/lib/g6-productos-ofertas/deploy-g6-service (con rollback activo).

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

[[ $EUID -eq 0 ]] || { printf 'Ejecutar con sudo/root.\n' >&2; exit 1; }

if [[ -f /etc/g6-productos-ofertas/azure.conf ]]; then
  # shellcheck disable=SC1091
  source /etc/g6-productos-ofertas/azure.conf
fi

readonly REGISTRY_PREFIX="${G6_REGISTRY_PREFIX:-ghcr.io/axl031/g6-productos-ofertas-backend}"
readonly IMAGE_SHA="${1:-$(git rev-parse HEAD)}"

[[ "$IMAGE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'SHA inválido: %s (se requiere SHA Git de 40 caracteres)\n' "$IMAGE_SHA" >&2
  exit 1
}

for svc in taxonomy-svc catalog-svc api-gateway; do
  if grep -q 'REEMPLAZAR_PASSWORD' "/etc/g6-${svc}/runtime.env" 2>/dev/null; then
    printf 'ERROR: /etc/g6-%s/runtime.env aún contiene REEMPLAZAR_PASSWORD. Configura las credenciales reales antes de desplegar.\n' "$svc" >&2
    exit 1
  fi
done

for svc in taxonomy-svc catalog-svc api-gateway; do
  image_tag="${REGISTRY_PREFIX}/${svc}:${IMAGE_SHA}"
  echo "=== [BUILD] Construyendo ${image_tag} ==="
  docker build \
    --file Dockerfile.service \
    --build-arg "SERVICE_NAME=${svc}" \
    --tag "$image_tag" \
    .

  echo "=== [DEPLOY] Desplegando ${svc} (${IMAGE_SHA}) mediante deploy-g6-service ==="
  env SSH_ORIGINAL_COMMAND="service-deploy ${svc} ${IMAGE_SHA}" \
    /usr/local/lib/g6-productos-ofertas/deploy-g6-service </dev/null

  echo "=== [VERIFY] Estado post-deploy de ${svc} ==="
  docker inspect --format '{{.Name}} image={{.Config.Image}} health={{.State.Health.Status}}' "g6-${svc}"
done

echo "=== [READINESS] Comprobando readiness de los 3 componentes ==="
curl --fail --silent --show-error http://127.0.0.1:3006/health/ready && echo ""
curl --fail --silent --show-error http://127.0.0.1:3001/health/ready && echo ""
docker exec g6-api-gateway node dist/apps/api-gateway/readiness.js
