#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# == 1 ]] || { echo 'uso: smoke-service.sh <servicio>' >&2; exit 2; }
service="$1"
service_key="${service^^}"
service_key="${service_key//-/_}"
case "$service" in
  api-gateway) readiness_path='' ;;
  bulk-svc) readiness_path='/health/readiness' ;;
  catalog-svc) readiness_path='/health/ready' ;;
  combos-svc) readiness_path='/health/ready' ;;
  inventory-svc) readiness_path='/health/readiness' ;;
  price-audit-svc|pricing-svc|promotions-svc|taxonomy-svc) readiness_path='/health/ready' ;;
  *) echo 'servicio fuera de la allowlist de nueve aplicaciones' >&2; exit 2 ;;
esac

base="${SMOKE_URL:-}"
if [[ -z "$base" ]]; then
  printf 'BLOQUEADO: falta AZURE_SMOKE_URL_%s; no se ejecutó smoke funcional.\n' "$service_key" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2
  exit 1
fi
[[ "$base" =~ ^https://[^/]+/?$ ]] || { echo 'URL smoke debe ser HTTPS y no incluir una ruta.' >&2; exit 2; }
base="${base%/}"
[[ -n "${SMOKE_PROTECTED_PATH:-}" ]] || {
  printf 'BLOQUEADO: falta AZURE_SMOKE_PROTECTED_%s; no se probó el rechazo sin credenciales.\n' "$service_key" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2
  exit 1
}
[[ "$SMOKE_PROTECTED_PATH" == /* && "$SMOKE_PROTECTED_PATH" != *'?'* ]] || { echo 'La ruta protegida debe ser una ruta absoluta sin query.' >&2; exit 2; }
readonly max_attempts="${SMOKE_MAX_ATTEMPTS:-6}"
readonly request_timeout="${SMOKE_REQUEST_TIMEOUT:-20}"
readonly retry_delay="${SMOKE_RETRY_DELAY_SECONDS:-5}"

request_2xx() {
  local path="$1" body status attempt
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    body="$(mktemp)"
    status="$(curl --silent --show-error --max-time "$request_timeout" --output "$body" --write-out '%{http_code}' "${base}${path}" 2>/dev/null || true)"
    if [[ "$status" =~ ^2[0-9][0-9]$ ]] && jq -e 'type == "object" or type == "array"' "$body" >/dev/null 2>&1; then
      printf 'PASS %s HTTP %s intento %s/%s\n' "$path" "$status" "$attempt" "$max_attempts"
      rm -f "$body"
      return 0
    fi
    printf 'Reintento %s/%s HTTP %s en %s\n' "$attempt" "$max_attempts" "${status:-sin-respuesta}" "$path" >&2
    rm -f "$body"
    (( attempt == max_attempts )) || sleep "$retry_delay"
  done
  return 1
}

request_2xx '/health' || { echo "FALLO de liveness: $service" >&2; exit 1; }
if [[ -n "$readiness_path" ]]; then
  request_2xx "$readiness_path" || { echo "FALLO de readiness: $service" >&2; exit 1; }
else
  echo "Nota: $service no tiene ruta HTTP readiness en este contrato; /health acredita solo liveness y la ruta protegida es obligatoria."
fi

status="$(curl --silent --show-error --max-time "$request_timeout" --output /dev/null --write-out '%{http_code}' "${base}${SMOKE_PROTECTED_PATH}" 2>/dev/null || true)"
[[ "$status" == 401 || "$status" == 403 ]] || {
  printf 'FALLO: la ruta protegida %s respondió %s sin credenciales.\n' "$SMOKE_PROTECTED_PATH" "${status:-sin-respuesta}" >&2
  exit 1
}
printf 'PASS ruta protegida sin credenciales: HTTP %s %s\n' "$status" "$SMOKE_PROTECTED_PATH"

{
  printf "Infraestructura HTTP verificada para \`%s\`: liveness 200." "$service"
  [[ -z "$readiness_path" ]] || printf " Readiness \`%s\` 2xx." "$readiness_path"
  printf ' La ruta protegida respondió 401/403 sin credenciales.'
  printf '\n'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
