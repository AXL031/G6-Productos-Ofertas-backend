#!/usr/bin/env bash
set -Eeuo pipefail

readonly expected_branch='integracion/h4-fase1-completa'
readonly repository='ghcr.io/taller-sw-web/g6-productos-ofertas-backend'
readonly branch="$(git branch --show-current)"
readonly sha="$(git rev-parse HEAD)"

[[ "$branch" == "$expected_branch" ]] || {
  printf 'FALLO: se requiere la rama %s; se encontró %s\n' "$expected_branch" "$branch" >&2
  exit 1
}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'FALLO: HEAD no es un SHA completo\n' >&2
  exit 1
}
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || {
  printf 'FALLO: el checkout debe estar limpio para etiquetar imágenes por SHA\n' >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  printf 'FALLO: Docker es requerido para construir la release local\n' >&2
  exit 1
}

services=(api-gateway bulk-svc catalog-svc combos-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc)
for service in "${services[@]}"; do
  image="$repository/$service:$sha"
  printf 'Construyendo %s\n' "$image"
  docker build --file Dockerfile.service --build-arg "SERVICE_NAME=$service" --tag "$image" .
  docker image inspect "$image" --format '{{.Id}}' >/dev/null
done

image="$repository/inventory-svc:$sha"
printf 'Construyendo %s\n' "$image"
docker build --file Dockerfile.inventory-svc --tag "$image" .
docker image inspect "$image" --format '{{.Id}}' >/dev/null

printf 'PASS: nueve imágenes locales construidas desde %s\n' "$sha"
printf 'PUBLICACIÓN: no ejecutada\n'
