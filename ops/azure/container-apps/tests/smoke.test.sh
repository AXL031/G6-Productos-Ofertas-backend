#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
cat > "$TEMP/curl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
output=''
url=''
while (($#)); do
  case "$1" in
    --output) shift; output="$1" ;;
    https://*) url="$1" ;;
  esac
  shift
done
if [[ -n "$output" && "$output" != /dev/null ]]; then printf '{"status":"ready"}' > "$output"; fi
if [[ "$url" == *'/private/read' ]]; then printf '401'; exit 0; fi
if [[ "${MOCK_READINESS_FAILURE:-false}" == true && "$url" == */health/ready || "${MOCK_READINESS_FAILURE:-false}" == true && "$url" == */health/readiness ]]; then printf '503'; else printf '200'; fi
MOCK
chmod +x "$TEMP/curl"

PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/pass.log"
grep -Fq 'PASS /health HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS /health/ready HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS ruta protegida sin credenciales: HTTP 401' "$TEMP/pass.log"
echo 'PASS: liveness, readiness y rechazo 401 sin token'

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_MAX_ATTEMPTS=1 MOCK_READINESS_FAILURE=true \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" inventory-svc > "$TEMP/fail.log" 2>&1; then
  echo 'FAIL: readiness 503 debe detener smoke' >&2; exit 1
fi
grep -Fq 'FALLO de readiness: inventory-svc' "$TEMP/fail.log"
echo 'PASS: readiness no disponible falla el smoke'

PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" taxonomy-svc > "$TEMP/pending.log"
grep -Fq 'PENDIENTE: falta URL HTTPS configurada' "$TEMP/pending.log"
echo 'PASS: ausencia de URL deja evidencia pendiente sin afirmar smoke funcional'

if PATH="$TEMP:$PATH" SMOKE_URL='http://example.invalid' bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc >/dev/null 2>&1; then
  echo 'FAIL: URL no HTTPS aceptada' >&2; exit 1
fi
echo 'PASS: URL no HTTPS rechazada'
