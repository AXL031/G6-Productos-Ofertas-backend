#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEMP_ROOT="$(mktemp -d)"
readonly MOCK_STATE="$TEMP_ROOT/api-state"
readonly MOCK_BIN="$TEMP_ROOT/bin"
readonly REPO="$TEMP_ROOT/repo"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$MOCK_STATE" "$MOCK_BIN" "$REPO" "$TEMP_ROOT/ops/oracle"
cp "$ROOT/ops/oracle/service-registry.sh" "$ROOT/ops/oracle/services.psv" \
  "$ROOT/ops/oracle/select-cd-services.sh" "$ROOT/ops/oracle/github-deployment-api.sh" \
  "$TEMP_ROOT/ops/oracle/"
readonly ORACLE_DIR="$TEMP_ROOT/ops/oracle"

# Sustituye GitHub API y jq por dobles deterministas; valida argumentos,
# parámetros de consulta y payloads, y persiste lo escrito para que el selector
# ejecute la lectura sobre la misma API simulada.
cat > "$MOCK_BIN/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == api ]] || exit 2
shift
method=GET input= endpoint= state= description= jq=
while (($#)); do
  case "$1" in
    --paginate) shift ;;
    --method) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --jq) jq="$2"; shift 2 ;;
    -f) key="${2%%=*}"; value="${2#*=}"; [[ "$key" == state ]] && state="$value" || description="$value"; shift 2 ;;
    -*) echo "opción inesperada: $1" >&2; exit 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done
deployments="$MOCK_STATE/deployments.tsv"
if [[ "$method" == POST && "$endpoint" == repos/example/backend/deployments ]]; then
  expected="{\"ref\":\"$EXPECT_SHA\",\"task\":\"deploy\",\"environment\":\"g6-oracle-inventory-svc\",\"auto_merge\":false,\"required_contexts\":[],\"production_environment\":true,\"payload\":{\"trigger\":\"workflow_dispatch\",\"run_id\":\"77\"}}"
  [[ -n "$input" && "$jq" == .id && "$(cat "$input")" == "$expected" ]] || { echo 'payload de creación inválido' >&2; exit 2; }
  id=100
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$EXPECT_SHA" '2026-03-01T00:00:00Z' g6-oracle-inventory-svc deploy >> "$deployments"
  : > "$MOCK_STATE/$id.statuses.tsv"
  printf '%s\n' "$id"
elif [[ "$method" == POST && "$endpoint" =~ ^repos/example/backend/deployments/([0-9]+)/statuses$ ]]; then
  id="${BASH_REMATCH[1]}"
  case "$state" in
    in_progress) expected='Despliegue Oracle en curso; aún no es una versión exitosa.' ;;
    success) expected='SSH completó el despliegue y sus verificaciones de salud.' ;;
    failure) expected='El despliegue remoto no terminó correctamente; no se avanza el SHA exitoso.' ;;
    *) exit 2 ;;
  esac
[[ "$description" == "$expected" && -f "$MOCK_STATE/$id.statuses.tsv" ]] || { echo 'payload de estado inválido' >&2; exit 2; }
  status_id="$(($(wc -l < "$MOCK_STATE/$id.statuses.tsv") + 1000))"
  printf '%s\t%s\t%s\n' "$status_id" "$state" '2026-03-01T00:00:00Z' >> "$MOCK_STATE/$id.statuses.tsv"
elif [[ "$method" == GET && "$endpoint" == repos/example/backend/deployments\?* ]]; then
  [[ "$endpoint" == *'environment=g6-oracle-inventory-svc'*'task=deploy'*'per_page=100'* ]] || { echo 'query de Deployments inválida' >&2; exit 2; }
  awk -F '\t' '$4 == "g6-oracle-inventory-svc" && $5 == "deploy" { print $1 "\t" $2 "\t" $3 }' "$deployments"
elif [[ "$method" == GET && "$endpoint" =~ ^repos/example/backend/deployments/([0-9]+)$ ]]; then
  id="${BASH_REMATCH[1]}"
  [[ "$id" == 100 ]] || exit 2
  printf 'g6-oracle-inventory-svc\tdeploy\t%s\t%s\t77\n' "$EXPECT_SHA" "${MOCK_TRIGGER:-workflow_dispatch}"
elif [[ "$method" == GET && "$endpoint" =~ ^repos/example/backend/actions/runs/([0-9]+)$ ]]; then
  case "${BASH_REMATCH[1]}" in
    77)
      printf 'Despliegue continuo de servicios Oracle\t.github/workflows/cd-services-oracle.yml\t%s\t%s\t%s\t%s\texample/backend\n' \
        "${MOCK_RUN_EVENT:-workflow_dispatch}" "${MOCK_RUN_BRANCH:-master}" "${MOCK_RUN_SHA:-$EXPECT_SHA}" "${MOCK_RUN_CONCLUSION:-success}"
      ;;
    88) printf 'Integración continua (CI)\t.github/workflows/ci.yml\tpush\tmaster\t%s\tsuccess\texample/backend\n' "$MOCK_AUTO_SHA" ;;
    *) exit 2 ;;
  esac
elif [[ "$method" == GET && "$endpoint" == repos/example/backend/commits/master ]]; then
  printf '%s\n' "$MOCK_AUTO_SHA"
elif [[ "$method" == GET && "$endpoint" =~ ^repos/example/backend/deployments/([0-9]+)/statuses\?per_page=100$ ]]; then
  id="${BASH_REMATCH[1]}"
  if [[ -n "${MOCK_STATUS_OVERRIDE:-}" ]]; then
    printf '9999\t%s\t2026-03-02T00:00:00Z\n' "$MOCK_STATUS_OVERRIDE"
  else
    [[ -f "$MOCK_STATE/$id.statuses.tsv" ]] && cat "$MOCK_STATE/$id.statuses.tsv"
  fi
else
  echo "solicitud API inesperada: $method $endpoint" >&2
  exit 2
fi
MOCK_GH
chmod +x "$MOCK_BIN/gh"

cat > "$MOCK_BIN/jq" <<'MOCK_JQ'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" == -cn && "$2" == --arg && "$3" == ref && "$5" == --arg && "$6" == environment && "$8" == --arg && "$9" == trigger && "${11}" == --arg && "${12}" == run_id && "${14}" == '{ref:$ref, task:"deploy", environment:$environment, auto_merge:false, required_contexts:[], production_environment:true, payload:{trigger:$trigger,run_id:$run_id}}' ]] || exit 2
printf '{"ref":"%s","task":"deploy","environment":"%s","auto_merge":false,"required_contexts":[],"production_environment":true,"payload":{"trigger":"%s","run_id":"%s"}}\n' "$4" "$7" "${10}" "${13}"
MOCK_JQ
chmod +x "$MOCK_BIN/jq"

git init --quiet --initial-branch=master "$REPO"
git -C "$REPO" config user.name 'Pruebas INFRA-002'
git -C "$REPO" config user.email 'infra-002@example.invalid'
mkdir -p "$REPO/apps/inventory-svc/src"
printf 'base\n' > "$REPO/apps/inventory-svc/src/main.ts"
git -C "$REPO" add .
git -C "$REPO" commit --quiet -m 'base'
readonly SHA_A="$(git -C "$REPO" rev-parse HEAD)"
readonly SHA_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
[[ "$SHA_A" != "$SHA_B" ]] || { echo 'FALLO: fixture de SHA histórico y futuro debe diferir.' >&2; exit 1; }

run_api() { env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" bash "$ORACLE_DIR/github-deployment-api.sh" "$@"; }
run_selector() { (cd "$REPO" && env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" bash "$ORACLE_DIR/select-cd-services.sh" manual inventory-svc); }

deployment_id="$(run_api create example/backend inventory-svc "$SHA_A" workflow_dispatch 77)"
[[ "$deployment_id" == 100 ]]
[[ "$(run_selector)" == '["inventory-svc"]' ]]
run_api status example/backend "$deployment_id" success
auto_output="$TEMP_ROOT/automatic-selection"
: > "$auto_output"
env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" MOCK_AUTO_SHA="$SHA_B" \
  GITHUB_REPOSITORY=example/backend GITHUB_REF=refs/heads/master GITHUB_SHA="$SHA_B" GITHUB_OUTPUT="$auto_output" \
  TRIGGER_EVENT=workflow_run CI_RUN_ID=88 CI_NAME="Integración continua (CI)" CI_PATH=.github/workflows/ci.yml CI_EVENT=push \
  CI_BRANCH=master CI_SHA="$SHA_B" CI_CONCLUSION=success CI_HEAD_REPOSITORY=example/backend \
  bash "$ROOT/ops/oracle/validate-cd-source.sh"
grep -qx "sha=$SHA_B" "$auto_output"
env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" bash "$ROOT/ops/oracle/verify-manual-release-provenance.sh" example/backend "$deployment_id" inventory-svc https://github.com/example/backend/actions/runs/77/readiness
if env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" MOCK_TRIGGER=workflow_run bash "$ROOT/ops/oracle/verify-manual-release-provenance.sh" example/backend "$deployment_id" inventory-svc https://github.com/example/backend/actions/runs/77/readiness >/dev/null 2>&1; then
  echo 'FALLO: un Deployment automático se aceptó como liberación manual.' >&2
  exit 1
fi
echo 'CORRECTO: procedencia workflow_run rechazada como evidencia de liberación manual.'
if env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" MOCK_RUN_SHA="$SHA_B" bash "$ROOT/ops/oracle/verify-manual-release-provenance.sh" example/backend "$deployment_id" inventory-svc https://github.com/example/backend/actions/runs/77/readiness >/dev/null 2>&1; then
  echo 'FALLO: se aceptó una ejecución manual cuyo SHA difiere del Deployment.' >&2
  exit 1
fi
echo 'CORRECTO: Deployment manual en SHA A se acepta como autorización independiente para SHA automático B; run con SHA distinto se rechaza.'
for overrides in 'MOCK_RUN_CONCLUSION=failure' 'MOCK_RUN_BRANCH=feature'; do
  if env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" $overrides bash "$ROOT/ops/oracle/verify-manual-release-provenance.sh" example/backend "$deployment_id" inventory-svc https://github.com/example/backend/actions/runs/77/readiness >/dev/null 2>&1; then
    echo "FALLO: ejecución manual con $overrides se aceptó." >&2
    exit 1
  fi
done
if env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" MOCK_STATUS_OVERRIDE=failure bash "$ROOT/ops/oracle/verify-manual-release-provenance.sh" example/backend "$deployment_id" inventory-svc https://github.com/example/backend/actions/runs/77/readiness >/dev/null 2>&1; then
  echo 'FALLO: Deployment manual fallido se aceptó.' >&2
  exit 1
fi
if env PATH="$MOCK_BIN:$PATH" MOCK_STATE="$MOCK_STATE" EXPECT_SHA="$SHA_A" bash "$ROOT/ops/oracle/verify-manual-release-provenance.sh" example/backend "$deployment_id" inventory-svc '' >/dev/null 2>&1; then
  echo 'FALLO: se aceptó evidencia funcional vacía.' >&2
  exit 1
fi
echo 'CORRECTO: rama, conclusión, estado del Deployment y evidencia vacía se rechazan.'
printf 'CORRECTO: mock API validó parámetros, creación, estados y lectura del baseline exitoso.\n'

if run_api create example/backend pricing-svc "$SHA_A" workflow_dispatch 77 >/dev/null 2>&1; then
  echo 'FALLO: se permitió crear un Deployment para servicio deshabilitado.' >&2
  exit 1
fi
if run_api status example/backend '100/../../x' success >/dev/null 2>&1; then
  echo 'FALLO: se aceptó un ID externo que podría alterar el endpoint.' >&2
  exit 1
fi
printf 'CORRECTO: se rechazaron servicio deshabilitado e ID manipulado.\n'
