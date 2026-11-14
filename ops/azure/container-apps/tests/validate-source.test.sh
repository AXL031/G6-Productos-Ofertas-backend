#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
VALIDATOR="$ROOT/ops/azure/container-apps/validate-source.sh"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
cat > "$TEMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$*" in
  *'/commits/master'*) printf '%s\n' "$MOCK_MASTER" ;;
  *'/compare/'*) printf '%s\n' "$MOCK_COMPARE" ;;
  *'/actions/runs'*) printf '%s\n' "$MOCK_CI" ;;
  *) exit 41 ;;
esac
MOCK
chmod +x "$TEMP/bin/gh"
export PATH="$TEMP/bin:$PATH"
export GITHUB_REPOSITORY='Taller-SW-Web/G6-Productos-Ofertas-backend'
export GITHUB_REF='refs/heads/master'
export GH_TOKEN=fixture
export SOURCE_SHA=58b94a694fc22ad4401450feaffe8b708330518d
export MOCK_MASTER=2a97bd91e5d9fe85e4cc67f6bc960346481ed44a
export MOCK_COMPARE=ahead MOCK_CI=true
export GITHUB_OUTPUT="$TEMP/output"

expect_reject() {
  local label="$1"; shift
  local candidate_sha="$SOURCE_SHA"
  if [[ "${1:-}" == SOURCE_SHA=* ]]; then candidate_sha="${1#SOURCE_SHA=}"; shift; fi
  : > "$GITHUB_OUTPUT"
  if env "$@" bash "$VALIDATOR" manual catalog-svc "$candidate_sha" >/dev/null 2>&1; then
    printf 'FAIL: %s fue aceptado\n' "$label" >&2; exit 1
  fi
  [[ ! -s "$GITHUB_OUTPUT" ]] || { printf 'FAIL: %s escribió outputs\n' "$label" >&2; exit 1; }
  printf 'PASS: %s rechazado\n' "$label"
}

bash "$VALIDATOR" manual catalog-svc "$SOURCE_SHA" >/dev/null
grep -Fqx 'services=["catalog-svc"]' "$GITHUB_OUTPUT"
grep -Fqx "sha=$SOURCE_SHA" "$GITHUB_OUTPUT"
grep -Fqx "master_sha=$MOCK_MASTER" "$GITHUB_OUTPUT"
echo 'PASS: SHA completo anterior alcanzable desde master con CI exacta y servicio individual'

: > "$GITHUB_OUTPUT"
bash "$VALIDATOR" manual all "$SOURCE_SHA" >/dev/null
grep -Fqx 'services=["api-gateway","bulk-svc","catalog-svc","combos-svc","inventory-svc","price-audit-svc","pricing-svc","promotions-svc","taxonomy-svc"]' "$GITHUB_OUTPUT"
echo 'PASS: selección manual all limitada a los nueve servicios'

expect_reject 'SHA de formato inválido' SOURCE_SHA=not-a-sha
expect_reject 'fork/no repositorio oficial' GITHUB_REPOSITORY=Axel/G6-Productos-Ofertas-backend
expect_reject 'dispatch desde rama distinta a master' GITHUB_REF=refs/heads/codex/azure-h4-cd
expect_reject 'SHA no alcanzable desde master' MOCK_COMPARE=behind
expect_reject 'CI exacta no encontrada o fallida' MOCK_CI=false

: > "$GITHUB_OUTPUT"
if bash "$VALIDATOR" auto catalog-svc "$SOURCE_SHA" >/dev/null 2>&1; then
  echo 'FAIL: el modo automático obsoleto fue aceptado' >&2; exit 1
fi
echo 'PASS: el modo de disparo automático está deshabilitado'
