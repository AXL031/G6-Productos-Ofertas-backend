#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly VALIDATOR="$ROOT/ops/oracle/validate-cd-source.sh"
readonly TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/bin"

cat > "$TEMP_ROOT/bin/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  api)
    case "${2:-}" in
      "repos/${GITHUB_REPOSITORY}/actions/runs/${CI_RUN_ID}") printf '%s\n' "$MOCK_RUN_DATA" ;;
      "repos/${GITHUB_REPOSITORY}/commits/master") printf '%s\n' "$MOCK_MASTER_SHA" ;;
      *) echo "unexpected gh api endpoint" >&2; exit 2 ;;
    esac
    ;;
  run)
    [[ "${2:-}" == list ]] || exit 2
    printf '%s\n' "$MOCK_CI_SUCCESS"
    ;;
  *) exit 2 ;;
esac
MOCK_GH
chmod +x "$TEMP_ROOT/bin/gh"

readonly SHA="0123456789abcdef0123456789abcdef01234567"
readonly OLD_SHA="abcdef0123456789abcdef0123456789abcdef01"
readonly REPOSITORY='Taller-SW-Web/G6-Productos-Ofertas-backend'
readonly RUN_DATA="Integración continua (CI)$(printf '\t').github/workflows/ci.yml$(printf '\t')push$(printf '\t')master$(printf '\t')${SHA}$(printf '\t')success$(printf '\t')${REPOSITORY}"

run_validator() {
  local output="$TEMP_ROOT/output"
  : > "$output"
  env PATH="$TEMP_ROOT/bin:$PATH" GITHUB_OUTPUT="$output" GITHUB_REPOSITORY="$REPOSITORY" \
    MOCK_RUN_DATA="$RUN_DATA" MOCK_MASTER_SHA="$SHA" MOCK_CI_SUCCESS=true GH_TOKEN=mock \
    TRIGGER_EVENT=workflow_run CI_NAME="Integración continua (CI)" CI_PATH=.github/workflows/ci.yml CI_EVENT=push \
    CI_BRANCH=master CI_CONCLUSION=success CI_HEAD_REPOSITORY="$REPOSITORY" \
    CI_SHA="$SHA" CI_RUN_ID=123 bash "$VALIDATOR" "$@"
}

# A successful push CI from master on the current SHA is accepted.
run_validator >/dev/null
grep -Fq "sha=$SHA" "$TEMP_ROOT/output"
grep -Fq "repository=${REPOSITORY,,}" "$TEMP_ROOT/output"
automatic_services="$(bash "$ROOT/ops/oracle/select-cd-services.sh" automatic "$REPOSITORY")"
[[ "$automatic_services" == '[]' ]] || { echo 'FALLO: valid CI push must no-op while auto authorization is empty.' >&2; exit 1; }
echo 'CORRECTO: se validó workflow_run; los nueve servicios deshabilitados producen selección vacía.'

# A CI run caused by a PR is rejected, even when it comes from the same repository.
if env PATH="$TEMP_ROOT/bin:$PATH" GITHUB_OUTPUT="$TEMP_ROOT/pr-output" GITHUB_REPOSITORY="$REPOSITORY" \
  MOCK_RUN_DATA="$RUN_DATA" MOCK_MASTER_SHA="$SHA" GH_TOKEN=mock TRIGGER_EVENT=workflow_run \
  CI_NAME="Integración continua (CI)" CI_PATH=.github/workflows/ci.yml CI_EVENT=pull_request CI_BRANCH=master \
  CI_CONCLUSION=success CI_HEAD_REPOSITORY="$REPOSITORY" CI_SHA="$SHA" CI_RUN_ID=123 \
  bash "$VALIDATOR" >/dev/null 2>&1; then
  echo 'FALLO: pull_request event was accepted.' >&2
  exit 1
fi
echo 'CORRECTO: evento pull_request rechazado'

# A failed or cancelled CI run is rejected even for a master push.
if env PATH="$TEMP_ROOT/bin:$PATH" GITHUB_OUTPUT="$TEMP_ROOT/failed-ci-output" GITHUB_REPOSITORY="$REPOSITORY" \
  MOCK_RUN_DATA="$RUN_DATA" MOCK_MASTER_SHA="$SHA" GH_TOKEN=mock TRIGGER_EVENT=workflow_run \
  CI_NAME="Integración continua (CI)" CI_PATH=.github/workflows/ci.yml CI_EVENT=push CI_BRANCH=master \
  CI_CONCLUSION=failure CI_HEAD_REPOSITORY="$REPOSITORY" CI_SHA="$SHA" CI_RUN_ID=123 \
  bash "$VALIDATOR" >/dev/null 2>&1; then
  echo 'FALLO: unsuccessful CI event was accepted.' >&2
  exit 1
fi
echo 'CORRECTO: ejecución CI fallida rechazada'

# A fork is rejected even when the event/branch/result otherwise look valid.
if env PATH="$TEMP_ROOT/bin:$PATH" GITHUB_OUTPUT="$TEMP_ROOT/fork-output" GITHUB_REPOSITORY="$REPOSITORY" \
  MOCK_RUN_DATA="$RUN_DATA" MOCK_MASTER_SHA="$SHA" GH_TOKEN=mock TRIGGER_EVENT=workflow_run \
  CI_NAME="Integración continua (CI)" CI_PATH=.github/workflows/ci.yml CI_EVENT=push CI_BRANCH=master \
  CI_CONCLUSION=success CI_HEAD_REPOSITORY=untrusted/fork CI_SHA="$SHA" CI_RUN_ID=123 \
  bash "$VALIDATOR" >/dev/null 2>&1; then
  echo 'FALLO: fork CI event was accepted.' >&2
  exit 1
fi
echo 'CORRECTO: evento de fork rechazado'

# A well-formed but stale SHA is a no-op and produces no deployable SHA output.
stale_output="$TEMP_ROOT/stale-output"
: > "$stale_output"
if ! env PATH="$TEMP_ROOT/bin:$PATH" GITHUB_OUTPUT="$stale_output" GITHUB_REPOSITORY="$REPOSITORY" \
  MOCK_RUN_DATA="Integración continua (CI)$(printf '\t').github/workflows/ci.yml$(printf '\t')push$(printf '\t')master$(printf '\t')${OLD_SHA}$(printf '\t')success$(printf '\t')${REPOSITORY}" \
  MOCK_MASTER_SHA="$SHA" GH_TOKEN=mock TRIGGER_EVENT=workflow_run CI_NAME="Integración continua (CI)" \
  CI_PATH=.github/workflows/ci.yml CI_EVENT=push CI_BRANCH=master CI_CONCLUSION=success \
  CI_HEAD_REPOSITORY="$REPOSITORY" CI_SHA="$OLD_SHA" CI_RUN_ID=124 bash "$VALIDATOR" >/dev/null; then
  echo 'FALLO: stale SHA validation returned an error instead of a safe no-op.' >&2
  exit 1
fi
grep -Fxq 'sha=' "$stale_output"
if grep -Eq '^sha=.+$' "$stale_output"; then
  echo 'FALLO: stale SHA produced a deployable output.' >&2
  exit 1
fi
echo 'CORRECTO: un SHA obsoleto se omite'

# Manual dispatch is retained but still requires a successful push CI on master.
manual_output="$TEMP_ROOT/manual-output"
: > "$manual_output"
env PATH="$TEMP_ROOT/bin:$PATH" GITHUB_OUTPUT="$manual_output" GITHUB_REPOSITORY="$REPOSITORY" \
  GITHUB_REF=refs/heads/master GITHUB_SHA="$SHA" MOCK_MASTER_SHA="$SHA" \
  MOCK_CI_SUCCESS=true GH_TOKEN=mock TRIGGER_EVENT=workflow_dispatch \
  CI_RUN_ID=123 \
  bash "$VALIDATOR" >/dev/null
grep -Fq "sha=$SHA" "$manual_output"
echo 'CORRECTO: dispatch manual exige CI exitosa de master'
