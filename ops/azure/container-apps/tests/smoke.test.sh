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
if ! command -v jq >/dev/null 2>&1; then
  cat > "$TEMP/jq" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
file="${@: -1}"
node - "$file" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.exit(value !== null && typeof value === 'object' ? 0 : 1);
NODE
MOCK
  chmod +x "$TEMP/jq"
fi

PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' \
  SMOKE_MAX_ATTEMPTS=1 bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc > "$TEMP/pass.log"
grep -Fq 'PASS /health HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS /health/ready HTTP 200' "$TEMP/pass.log"
grep -Fq 'PASS ruta protegida sin credenciales: HTTP 401' "$TEMP/pass.log"
echo 'PASS: liveness, readiness y rechazo 401 sin token'

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_PROTECTED_PATH='/private/read' SMOKE_MAX_ATTEMPTS=1 MOCK_READINESS_FAILURE=true \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" inventory-svc > "$TEMP/fail.log" 2>&1; then
  echo 'FAIL: el servicio con readiness 503 debe bloquear smoke' >&2; exit 1
fi
grep -Fq 'FALLO de readiness: inventory-svc' "$TEMP/fail.log"
echo 'PASS: fallo real del servicio (readiness 503) bloquea el smoke'

if PATH="$TEMP:$PATH" bash "$ROOT/ops/azure/container-apps/smoke-service.sh" taxonomy-svc > "$TEMP/no-url.log" 2>&1; then
  echo 'FAIL: ausencia de URL debe bloquear el smoke' >&2; exit 1
fi
grep -Fq 'BLOQUEADO: falta AZURE_SMOKE_URL_TAXONOMY_SVC' "$TEMP/no-url.log"
echo 'PASS: ausencia de URL bloquea el smoke y el job'

if PATH="$TEMP:$PATH" SMOKE_URL='https://example.invalid' SMOKE_MAX_ATTEMPTS=1 \
  bash "$ROOT/ops/azure/container-apps/smoke-service.sh" taxonomy-svc > "$TEMP/no-protected.log" 2>&1; then
  echo 'FAIL: ruta protegida ausente debe bloquear el smoke' >&2; exit 1
fi
grep -Fq 'BLOQUEADO: falta AZURE_SMOKE_PROTECTED_TAXONOMY_SVC' "$TEMP/no-protected.log"
echo 'PASS: ruta protegida no configurada bloquea el smoke y el job'

if PATH="$TEMP:$PATH" SMOKE_URL='http://example.invalid' bash "$ROOT/ops/azure/container-apps/smoke-service.sh" catalog-svc >/dev/null 2>&1; then
  echo 'FAIL: URL no HTTPS aceptada' >&2; exit 1
fi
echo 'PASS: URL no HTTPS rechazada'
