#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
cat > "$TEMP/curl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
output=''
while (($#)); do
  if [[ "$1" == --output ]]; then shift; output="$1"; fi
  shift || true
done
printf '{"error":"fixture"}' > "$output"
printf '503'
MOCK
chmod +x "$TEMP/curl"
if PATH="$TEMP:$PATH" SMOKE_BASE_URL='https://example.invalid' SMOKE_MAX_ATTEMPTS=1 SMOKE_RETRY_DELAY_SECONDS=0 bash "$ROOT/ops/azure/container-apps/smoke-marketplace.sh" > "$TEMP/smoke.log" 2>&1; then
  echo 'FAIL: smoke debe fallar ante respuesta funcional 503' >&2
  exit 1
fi
grep -Fq 'FALLO de smoke HTTPS' "$TEMP/smoke.log"
echo 'PASS: smoke Marketplace informa fallo funcional para activar recuperación coordinada'
