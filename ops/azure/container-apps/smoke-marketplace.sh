#!/usr/bin/env bash
set -Eeuo pipefail

readonly base="${SMOKE_BASE_URL:-https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io}"
readonly -a paths=(
  '/api/v1/categorias'
  '/api/v1/marcas'
  '/api/v1/productos?canal=MARKETPLACE'
  '/api/v1/productos/32a4172c-81b2-b643-1d0f-ae66f627f2ef?canal=MARKETPLACE'
  '/api/v1/productos/por-slug/ent22-inka-athletics?canal=MARKETPLACE'
)
readonly max_attempts="${SMOKE_MAX_ATTEMPTS:-6}"
readonly request_timeout="${SMOKE_REQUEST_TIMEOUT:-20}"
readonly retry_delay="${SMOKE_RETRY_DELAY_SECONDS:-5}"

for path in "${paths[@]}"; do
  success=false
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    body="$(mktemp)"
    status="$(curl --silent --show-error --max-time "$request_timeout" --output "$body" --write-out '%{http_code}' "${base}${path}" 2>/dev/null || true)"
    if [[ "$status" == 200 ]] && jq -e 'type == "array" or type == "object"' "$body" >/dev/null 2>&1; then
      printf 'PASS HTTP %s intento %s/%s: %s\n' "$status" "$attempt" "$max_attempts" "$path"
      success=true
      rm -f "$body"
      break
    fi
    printf 'Reintento %s/%s HTTP %s: %s\n' "$attempt" "$max_attempts" "${status:-sin-respuesta}" "$path" >&2
    rm -f "$body"
    (( attempt == max_attempts )) || sleep "$retry_delay"
  done
  [[ "$success" == true ]] || { printf 'FALLO de smoke HTTPS: %s\n' "$path" >&2; exit 1; }
done
