#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORKFLOW="${ROOT}/.github/workflows/cd-services-oracle.yml"
readonly LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

grep -Eq '^  release:$' "$WORKFLOW"
grep -Eq '^      fail-fast: false$' "$WORKFLOW"
grep -Fq '        service: ${{ fromJSON(needs.prepare.outputs.services) }}' "$WORKFLOW"
grep -Fq '      group: deploy-g6-services-oracle-${{ github.repository }}-${{ matrix.service }}' "$WORKFLOW"
grep -Fq '      cancel-in-progress: false' "$WORKFLOW"
grep -Fq 'Verificar o reservar imagen inmutable por SHA' "$WORKFLOW"
grep -Fq 'ensure-ghcr-sha-image.sh' "$WORKFLOW"
grep -Fq "steps.image.outputs.exists == 'false'" "$WORKFLOW"
grep -Eq '^        type: choice$' "$WORKFLOW"
publish_line="$(grep -n 'name: Construir y publicar imagen etiquetada con SHA' "$WORKFLOW" | cut -d: -f1)"
deployment_line="$(grep -n '^      - name: Registrar intento de despliegue$' "$WORKFLOW" | cut -d: -f1)"
remote_line="$(grep -n '^      - name: Desplegar imagen, comprobar salud y recuperar ante fallo$' "$WORKFLOW" | cut -d: -f1)"
success_line="$(grep -n '^      - name: Registrar despliegue exitoso después de comprobar salud remota$' "$WORKFLOW" | cut -d: -f1)"
((publish_line < deployment_line && deployment_line < remote_line && remote_line < success_line)) || {
  echo 'FALLO: el deployment exitoso no está ordenado después de publicación y verificación remota.' >&2
  exit 1
}
if grep -Eq '^  publish:$|needs\.publish\.result' "$WORKFLOW"; then
  echo 'FALLO: la publicación todavía es una barrera agregada para otras filas.' >&2
  exit 1
fi

publish_one() {
  local service="$1"
  printf 'publish:%s\n' "$service" >> "$LOG"
  [[ "$service" != catalog-svc ]]
}
release_one() {
  local service="$1"
  publish_one "$service" || return
  printf 'deploy:%s\n' "$service" >> "$LOG"
}

if release_one catalog-svc; then
  echo 'FALLO: la publicación simulada debía fallar.' >&2
  exit 1
fi
release_one inventory-svc
[[ "$(<"$LOG")" == $'publish:catalog-svc\npublish:inventory-svc\ndeploy:inventory-svc' ]] || {
  echo 'FALLO: un fallo de publicación afectó el servicio independiente.' >&2
  exit 1
}
printf 'CORRECTO: publicación fallida aislada de otra fila de servicio\n'
