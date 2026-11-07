#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
readonly ROOT
readonly VALIDATOR="$ROOT/ops/azure/container-apps/validate-source.sh"
TEMP="$(mktemp -d)"
readonly TEMP
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
cat > "$TEMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == *'/commits/master'* ]]; then printf '%s\n' "$MOCK_MASTER"; exit 0; fi
if [[ "$*" == *'/actions/runs'* ]]; then printf '%s\n' "$MOCK_CI"; exit 0; fi
exit 41
MOCK
chmod +x "$TEMP/bin/gh"
export PATH="$TEMP/bin:$PATH"
export GITHUB_REPOSITORY='Taller-SW-Web/G6-Productos-Ofertas-backend'
export GITHUB_REF='refs/heads/master'
export GITHUB_SHA='58b94a694fc22ad4401450feaffe8b708330518d'
export GH_TOKEN=fixture
export SOURCE_SHA="$GITHUB_SHA"
export MOCK_MASTER="$GITHUB_SHA"
export MOCK_CI=true
export GITHUB_OUTPUT="$TEMP/output"

expect_reject() {
  local label="$1"; shift
  : > "$GITHUB_OUTPUT"
  if env "$@" bash "$VALIDATOR" auto automatic "$SOURCE_SHA" >/dev/null 2>&1; then
    printf 'FAIL: %s fue aceptado\n' "$label" >&2; exit 1
  fi
  [[ ! -s "$GITHUB_OUTPUT" ]] || { printf 'FAIL: %s escribió outputs\n' "$label" >&2; exit 1; }
  printf 'PASS: %s rechazado\n' "$label"
}

export CI_REPOSITORY="$GITHUB_REPOSITORY" CI_BRANCH=master CI_EVENT=push CI_CONCLUSION=success CI_SHA="$SOURCE_SHA"
bash "$VALIDATOR" auto automatic "$SOURCE_SHA" >/dev/null
grep -Fqx 'services=["api-gateway","catalog-svc","taxonomy-svc"]' "$GITHUB_OUTPUT"
printf 'PASS: workflow_run oficial, CI exacta y tres servicios iniciales\n'
expect_reject 'origen fork' CI_REPOSITORY=Axel/G6-Productos-Ofertas-backend
expect_reject 'CI fallida' CI_CONCLUSION=failure
expect_reject 'rama no autorizada' CI_BRANCH=cueva
expect_reject 'SHA CI diferente' CI_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export MOCK_MASTER=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
expect_reject 'SHA obsoleto' CI_REPOSITORY="$GITHUB_REPOSITORY"
export MOCK_MASTER="$SOURCE_SHA"
expect_reject 'CI no exitosa/no encontrada' MOCK_CI=false

: > "$GITHUB_OUTPUT"
bash "$VALIDATOR" manual all "$SOURCE_SHA" >/dev/null
grep -Fqx 'services=["api-gateway","bulk-svc","catalog-svc","combos-svc","inventory-svc","price-audit-svc","pricing-svc","promotions-svc","taxonomy-svc"]' "$GITHUB_OUTPUT"
printf 'PASS: selección manual all queda limitada a las nueve aplicaciones\n'
: > "$GITHUB_OUTPUT"
bash "$VALIDATOR" manual catalog-svc "$SOURCE_SHA" >/dev/null
grep -Fqx 'services=["catalog-svc"]' "$GITHUB_OUTPUT"
printf 'PASS: selección manual de un servicio es exacta\n'
if bash "$VALIDATOR" manual unknown "$SOURCE_SHA" >/dev/null 2>&1; then exit 1; fi
printf 'PASS: servicio no autorizado rechazado\n'
