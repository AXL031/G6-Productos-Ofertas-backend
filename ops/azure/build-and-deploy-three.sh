#!/usr/bin/env bash
set -Eeuo pipefail

# Development builds only. Releases use deploy-official-three.sh and the
# approved official digests, never a build from this fork.

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

readonly REGISTRY_PREFIX='g6-local-development'
readonly IMAGE_SHA="${1:-$(git rev-parse HEAD)}"

[[ "$IMAGE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'SHA inválido: %s (se requiere SHA Git de 40 caracteres)\n' "$IMAGE_SHA" >&2
  exit 1
}

[[ "$IMAGE_SHA" == "$(git rev-parse HEAD)" && -z "$(git status --porcelain)" ]] || {
  printf 'El SHA debe coincidir con HEAD y el checkout debe estar limpio.\n' >&2
  exit 1
}

for svc in taxonomy-svc catalog-svc api-gateway; do
  image_tag="${REGISTRY_PREFIX}/${svc}:${IMAGE_SHA}"
  echo "=== [BUILD] Construyendo ${image_tag} ==="
  docker build \
    --file Dockerfile.service \
    --build-arg "SERVICE_NAME=${svc}" \
    --label "org.opencontainers.image.revision=${IMAGE_SHA}" \
    --tag "$image_tag" \
    .
done
