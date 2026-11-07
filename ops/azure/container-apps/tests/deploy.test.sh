#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
readonly ROOT
readonly DEPLOY="$ROOT/ops/azure/container-apps/deploy.sh"
TEMP="$(mktemp -d)"
readonly TEMP
readonly PREVIOUS='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly TARGET='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/api-gateway@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
trap 'rm -rf "$TEMP"' EXIT
mkdir "$TEMP/bin"
cat > "$TEMP/state.json" <<EOF
{"properties":{"configuration":{"secrets":[{"name":"ACA_PRIVATE_SENTINEL","value":"must-not-be-printed"}],"ingress":{"external":true,"targetPort":3000}},"template":{"containers":[{"name":"api-gateway","image":"$PREVIOUS","env":[{"name":"PRIVATE_SETTING","value":"must-not-be-printed"}]},{"name":"Caddy","image":"ghcr.io/taller-sw-web/caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"scale":{"minReplicas":0,"maxReplicas":1}},"latestRevisionName":"rev-0","latestReadyRevisionName":"rev-0"},"revision":{"properties":{"healthState":"Healthy","active":true,"runningState":"Running"}},"updates":0}
EOF
cat > "$TEMP/bin/az" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${MOCK_STATE:?}"
[[ "$*" == *'--resource-group rg-g6-aca-chile'* ]] || { echo 'wrong resource group' >&2; exit 61; }
if [[ "${1:-}" == containerapp && "${2:-}" == show ]]; then cat "$state"; exit 0; fi
if [[ "${1:-}" == containerapp && "${2:-}" == revision && "${3:-}" == show ]]; then jq -c '.revision as $revision | .properties.template as $template | $revision + {properties: ($revision.properties + {template: $template})}' "$state"; exit 0; fi
if [[ "${1:-}" == containerapp && "${2:-}" == update ]]; then
  [[ "$*" == *'--container-name api-gateway'* ]] || { echo 'container name missing' >&2; exit 62; }
  image=''
  while (($#)); do [[ "$1" != --image ]] || { shift; image="$1"; }; shift || true; done
  [[ -n "$image" ]] || exit 63
  jq --arg image "$image" --arg unhealthy_target "${MOCK_UNHEALTHY_TARGET:-}" --arg unhealthy_rollback "${MOCK_UNHEALTHY_ROLLBACK:-false}" '
    .updates += 1 |
    .properties.template.containers |= map(if .name == "api-gateway" then .image=$image else . end) |
    .properties.latestRevisionName = ("rev-" + (.updates|tostring)) |
    .properties.latestReadyRevisionName = .properties.latestRevisionName |
    .revision.properties.healthState = (if $image == $unhealthy_target or ($unhealthy_rollback == "true" and ($image | contains("@sha256:aaaaaaaa"))) then "Unhealthy" else "Healthy" end) |
    .revision.properties.runningState = "Running"
  ' "$state" > "$state.tmp"
  mv "$state.tmp" "$state"
  exit 0
fi
exit 64
MOCK
chmod +x "$TEMP/bin/az"
export PATH="$TEMP/bin:$PATH" MOCK_STATE="$TEMP/state.json" ACA_POLL_ATTEMPTS=1 ACA_POLL_INTERVAL_SECONDS=0
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

if bash "$DEPLOY" bad-service "$TARGET" >/dev/null 2>&1; then fail 'servicio no autorizado'; fi
if bash "$DEPLOY" api-gateway "${TARGET%api-gateway@*}catalog-svc@${TARGET##*@}" >/dev/null 2>&1; then fail 'imagen de otro servicio'; fi
if bash "$DEPLOY" api-gateway "${TARGET%@*}" >/dev/null 2>&1; then fail 'imagen sin digest'; fi
printf 'PASS: rechaza servicio, paquete cruzado e imagen sin digest\n'

if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/deploy.log" 2>&1; then :; else cat "$TEMP/deploy.log"; fail 'despliegue esperado'; fi
jq -e --arg target "$TARGET" '.properties.template.containers[] | select(.name == "api-gateway") | .image == $target' "$MOCK_STATE" >/dev/null || fail 'imagen objetivo no aplicada'
jq -e '.properties.template.containers[] | select(.name == "Caddy") | .image | contains("cccccccc")' "$MOCK_STATE" >/dev/null || fail 'Caddy no conservado'
jq -e '.properties.configuration.ingress.external == true and .properties.configuration.secrets[0].value == "must-not-be-printed" and .properties.template.scale.maxReplicas == 1' "$MOCK_STATE" >/dev/null || fail 'configuración ACA no conservada'
if grep -Fq 'must-not-be-printed' "$TEMP/deploy.log"; then fail 'se imprimió configuración privada'; fi
printf 'PASS: actualización de un solo contenedor conserva Caddy/configuración y no imprime secretos\n'

updates="$(jq -r .updates "$MOCK_STATE")"
bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/idempotent.log" 2>&1 || fail 'despliegue idempotente'
[[ "$(jq -r .updates "$MOCK_STATE")" == "$updates" ]] || fail 'idempotencia creó una revisión'
grep -Fq Idempotencia "$TEMP/idempotent.log" || fail 'idempotencia no registrada'
printf 'PASS: repetir el mismo digest no crea otra revisión\n'

jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.healthState="Healthy"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
export MOCK_UNHEALTHY_TARGET="$TARGET"
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/rollback.log" 2>&1; then fail 'despliegue unhealthy aceptado'; fi
grep -Fq 'ROLLBACK VERIFICADO' "$TEMP/rollback.log" || { cat "$TEMP/rollback.log"; fail 'rollback no se verificó'; }
jq -e --arg previous "$PREVIOUS" '.properties.template.containers[] | select(.name == "api-gateway") | .image == $previous' "$MOCK_STATE" >/dev/null || fail 'rollback no restauró imagen previa'
printf 'PASS: fallo de revisión restaura y verifica digest anterior y configuración\n'

jq --arg previous "$PREVIOUS" '.properties.template.containers |= map(if .name == "api-gateway" then .image=$previous else . end) | .properties.latestRevisionName="rev-restore" | .properties.latestReadyRevisionName="rev-restore" | .revision.properties.healthState="Healthy"' "$MOCK_STATE" > "$TEMP/state.tmp"
mv "$TEMP/state.tmp" "$MOCK_STATE"
export MOCK_UNHEALTHY_ROLLBACK=true
if bash "$DEPLOY" api-gateway "$TARGET" > "$TEMP/rollback-fail.log" 2>&1; then fail 'rollback unhealthy aceptado'; fi
grep -Fq 'ROLLBACK NO VERIFICADO' "$TEMP/rollback-fail.log" || fail 'fallo de rollback no reportado'
printf 'PASS: nunca declara rollback si la verificación de recuperación falla\n'
