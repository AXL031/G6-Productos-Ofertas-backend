#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
VERIFIER="$ROOT/ops/azure/container-apps/verify-environment-protection.sh"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
cat > "$TEMP/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$*" in
  *'deployment-branch-policies'*) printf '%s\n' "${MOCK_BRANCHES:-master}" ;;
  *'prevent_self_review'*) printf '%s\n' "${MOCK_REVIEWERS:-1}" ;;
  *'custom_branch_policies'*) printf '%s\n' "${MOCK_BRANCH_MODE:-custom}" ;;
  *'/environments/azure-h5'*) [[ "${MOCK_ENV_EXISTS:-true}" == true ]] || exit 1; printf '{}\n' ;;
  *) exit 41 ;;
esac
MOCK
chmod +x "$TEMP/bin/gh"
export PATH="$TEMP/bin:$PATH" GH_TOKEN=fixture

bash "$VERIFIER" Taller-SW-Web/G6-Productos-Ofertas-backend >/dev/null
echo 'PASS: required reviewers, autoapproval prevention and exact master policy accepted'

expect_reject() {
  local label="$1"; shift
  if env "$@" bash "$VERIFIER" Taller-SW-Web/G6-Productos-Ofertas-backend >/dev/null 2>&1; then
    printf 'FAIL: %s fue aceptado\n' "$label" >&2; exit 1
  fi
  printf 'PASS: %s bloqueado\n' "$label"
}

expect_reject 'environment ausente' MOCK_ENV_EXISTS=false
expect_reject 'reviewers ausentes o autoaprobación permitida' MOCK_REVIEWERS=0
expect_reject 'deployment branches sin restricción personalizada a master' MOCK_BRANCH_MODE=invalid
expect_reject 'rama adicional habilitada' MOCK_BRANCHES=master,release
