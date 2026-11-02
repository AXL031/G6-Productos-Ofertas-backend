#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORKFLOW="$ROOT/.github/workflows/cd-services-oracle.yml"
readonly REGISTRY="$ROOT/ops/oracle/services.psv"
readonly SELECTOR="$ROOT/ops/oracle/select-cd-services.sh"
readonly REGISTRY_SH="$ROOT/ops/oracle/service-registry.sh"
readonly AUTO_AUTH="$ROOT/ops/oracle/auto-release-authorization.psv"
readonly SOURCE_VALIDATOR="$ROOT/ops/oracle/validate-cd-source.sh"

bash "$ROOT/ops/oracle/tests/validate-cd-source.test.sh"

echo "=== Verificando Registro de Servicios ==="
# Versionado y formato del registro
header="$(head -n 1 "$REGISTRY")"
[[ "$header" == '#registry-version=2' ]] || { echo "FALLO: versión del registro no es 2: $header" >&2; exit 1; }
# shellcheck source=../service-registry.sh
source "$REGISTRY_SH"

# Exactamente 9 servicios registrados en total
total_services="$(awk -F'|' '$1 !~ /^#/ && NF { count++ } END { print count+0 }' "$REGISTRY")"
[[ "$total_services" == 9 ]] || { echo "FALLO: se esperaban 9 servicios, encontrados $total_services" >&2; exit 1; }

# La decisión de infraestructura de Hito 3 habilita los nueve para dispatch
# manual; la preparación runtime y autorización de liberación siguen siendo gates.
readonly -a EXPECTED_ENABLED=(api-gateway bulk-svc catalog-svc combos-svc inventory-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc)

enabled_json="$(g6_enabled_services_json)"
expected_json='["api-gateway","bulk-svc","catalog-svc","combos-svc","inventory-svc","price-audit-svc","pricing-svc","promotions-svc","taxonomy-svc"]'
[[ "$enabled_json" == "$expected_json" ]] || {
  echo "FALLO: servicios habilitados no coinciden. Obtenido: $enabled_json, Esperado: $expected_json" >&2
  exit 1
}
echo "CORRECTO: los nueve servicios de Hito 3 están habilitados para dispatch manual: $enabled_json"

# Los nombres, puertos, proyectos, contenedores, estados y runtime files son únicos.
for field in 1 3 9 11 12 13; do
  awk -F'|' -v field="$field" '
    $1 !~ /^#/ && NF {
      value=$field
      if (value == "" || seen[value]++) invalid=1
      count++
    }
    END { exit (invalid || count != 9) }
  ' "$REGISTRY" || {
    echo "FALLO: campo de registro duplicado o incompleto: $field" >&2
    exit 1
  }
done
g6_service_config api-gateway
[[ "$G6_SERVICE_COMPOSE_FILE" == '/opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml' ]] || {
  echo "FALLO: api-gateway no usa su Compose dedicado para g6-edge" >&2
  exit 1
}
echo "CORRECTO: identidades/estado/runtime independientes y Compose dedicado de Gateway"

# Para cada servicio habilitado, el dispatch manual selecciona exactamente un servicio
for svc in "${EXPECTED_ENABLED[@]}"; do
  output="$(bash "$SELECTOR" manual "$svc")"
  [[ "$output" == "[\"$svc\"]" ]] || {
    echo "FALLO: selección manual de $svc no devolvió [\"$svc\"]: $output" >&2
    exit 1
  }
done
echo "CORRECTO: cada servicio habilitado es seleccionado individualmente mediante dispatch manual"

# El selector automático usa autorización independiente, inicialmente vacía.
[[ "$(head -n 1 "$AUTO_AUTH")" == '#auto-release-authorization-version=1' ]]
[[ "$(awk -F'|' '$1 !~ /^#/ && NF && $2 == "false" { n++ } END { print n+0 }' "$AUTO_AUTH")" == 9 ]]
auto_output="$(bash "$SELECTOR" automatic example/g6-backend)"
[[ "$auto_output" == '[]' ]] || { echo "FALLO: el auto CD inicial no está vacío: $auto_output" >&2; exit 1; }

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
cp "$REGISTRY" "$REGISTRY_SH" "$SELECTOR" "$AUTO_AUTH" "$temp_dir/"
sed -i 's/^catalog-svc|false||$/catalog-svc|true|12345|https:\/\/github.com\/example\/g6-backend\/actions\/runs\/67890/' "$temp_dir/auto-release-authorization.psv"
single_auto="$(bash "$temp_dir/select-cd-services.sh" automatic example/g6-backend)"
[[ "$single_auto" == '["catalog-svc"]' ]] || { echo "FALLO: la autorización individual no aisló catalog-svc: $single_auto" >&2; exit 1; }
sed -i 's#catalog-svc|true|12345|https://github.com/example/g6-backend/actions/runs/67890#catalog-svc|true|12345|#' "$temp_dir/auto-release-authorization.psv"
set +e
bash "$temp_dir/select-cd-services.sh" automatic example/g6-backend >/dev/null 2>&1
auto_missing_evidence_status=$?
set -e
[[ "$auto_missing_evidence_status" == 65 ]] || { echo 'FALLO: la autorización sin evidencia readiness/smoke no se rechazó.' >&2; exit 1; }
echo 'CORRECTO: autorización automática individual requiere liberación manual y evidencia readiness/smoke'

# Nombres inválidos son rechazados con código 64
for invalid in "unknown-svc" "catalogo" "inventario" "catalog-svc;id" "../../etc" "" " "; do
  set +e
  output="$(bash "$SELECTOR" manual "$invalid" 2>&1)"
  status=$?
  set -e
  [[ "$status" == 64 ]] || {
    echo "FALLO: entrada inválida '$invalid' no devolvió código 64: $status" >&2
    exit 1
  }
done
echo "CORRECTO: nombres inválidos o no registrados son rechazados con código 64"

echo "=== Verificando Seguridad del CD Oracle ==="
# 1. Trigger automático solo a través de workflow_run de CI; conserva dispatch manual
workflow_on="$(sed -n '/^on:/,/^[a-z]/p' "$WORKFLOW" | head -n -1)"
if grep -Eq '^[[:space:]]*pull_request:' <<< "$workflow_on"; then
  echo "FALLO: el CD no debe dispararse directamente en pull_request" >&2
  exit 1
fi
grep -Fq 'workflow_run:' <<< "$workflow_on" || { echo 'FALLO: falta workflow_run'; exit 1; }
grep -Fq 'workflows: [Integración continua (CI)]' <<< "$workflow_on" || { echo 'FALLO: workflow_run no está limitado a Integración continua (CI)'; exit 1; }
grep -Fq 'workflow_dispatch:' <<< "$workflow_on" || {
  echo "FALLO: la sección on: no declara workflow_dispatch" >&2
  exit 1
}
grep -Fq 'connectivity-check' "$WORKFLOW" || { echo 'FALLO: falta modo de conectividad'; exit 1; }
grep -Fq "inputs.mode == 'connectivity-check'" "$WORKFLOW" || { echo 'FALLO: conectividad no tiene guard exclusivo'; exit 1; }
grep -Fq 'ping: 100.87.22.28' "$WORKFLOW" || { echo 'FALLO: falta el ping oficial del action al host aprobado'; exit 1; }
release_ping_line="$(grep -nF 'ping: ${{ secrets.ORACLE_HOST }}' "$WORKFLOW" | cut -d: -f1)"
release_action_line="$(grep -n 'name: Conectar Tailscale con OIDC de GitHub' "$WORKFLOW" | tail -n 1 | cut -d: -f1)"
release_ssh_line="$(grep -n 'name: Verificar autenticación SSH restringida de GitHub Actions' "$WORKFLOW" | cut -d: -f1)"
[[ -n "$release_ping_line" && -n "$release_action_line" && -n "$release_ssh_line" && "$release_action_line" -lt "$release_ping_line" && "$release_ping_line" -lt "$release_ssh_line" ]] || { echo 'FALLO: release no espera ping oficial después de Tailscale y antes de SSH'; exit 1; }
[[ "$(grep -Fc 'ping: ${{ secrets.ORACLE_HOST }}' "$WORKFLOW")" -eq 1 ]] || { echo 'FALLO: se esperaba exactamente un ping oficial dinámico para release'; exit 1; }
if grep -Eq 'tailscale ping --c 1 --timeout=20s' "$WORKFLOW"; then
  echo 'FALLO: release conserva ping inmediato redundante' >&2
  exit 1
fi
grep -Fq 'continue-on-error: true' "$WORKFLOW" || { echo 'FALLO: no se ejecutaría el diagnóstico si falla el ping oficial'; exit 1; }
grep -Fq 'FALLO: Oracle no es visible como peer' "$WORKFLOW" || { echo 'FALLO: falta diagnóstico de peer no visible'; exit 1; }
grep -Fq 'timeout TCP/22' "$WORKFLOW" || { echo 'FALLO: falta diagnóstico de timeout/restricción TCP'; exit 1; }
if grep -Fq 'tailscale ping --c 1 --timeout=20s 100.87.22.28' "$WORKFLOW"; then
  echo 'FALLO: permanece el ping inmediato que falló en #47.' >&2
  exit 1
fi
checkout_line="$(grep -n 'name: Obtener master de confianza antes de validar' "$WORKFLOW" | cut -d: -f1)"
validator_line="$(grep -n 'name: Validar ejecución CI y seleccionar commit vigente de master' "$WORKFLOW" | cut -d: -f1)"
[[ -n "$checkout_line" && "$checkout_line" -lt "$validator_line" ]] || { echo 'FALLO: el validador se ejecuta antes del checkout confiable.'; exit 1; }
grep -Fq 'ref: refs/heads/master' "$WORKFLOW" || { echo 'FALLO: no se fija el checkout de validación a master'; exit 1; }
grep -Fq 'persist-credentials: false' "$WORKFLOW" || { echo 'FALLO: checkout de validación conserva credenciales'; exit 1; }
grep -Fq 'StrictHostKeyChecking=yes' "$WORKFLOW" || { echo 'FALLO: falta validación estricta SSH'; exit 1; }
grep -Fq 'SHA256:dVru76PK60yqZRYHUVtNNPUSYLtbS6ZE24mF0S/BhGY' "$WORKFLOW" || { echo 'FALLO: falta fingerprint aprobado'; exit 1; }
grep -Fq 'connectivity-probe' "$WORKFLOW" || { echo 'FALLO: falta probe inocuo'; exit 1; }
grep -Fq "inputs.mode == 'deploy'" "$WORKFLOW" || { echo 'FALLO: despliegue no está separado del modo conectividad'; exit 1; }
grep -Fq "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'" "$WORKFLOW" || {
  echo "FALLO: el disparador manual no está restringido a refs/heads/master" >&2
  exit 1
}
for guard in 'CI_EVENT:-' 'CI_BRANCH:-' 'CI_CONCLUSION:-' 'CI_HEAD_REPOSITORY' 'CI_SHA' 'OMITIDO: revisión obsoleta'; do
  grep -Fq "$guard" "$SOURCE_VALIDATOR" || { echo "FALLO: falta validación de evento CI $guard" >&2; exit 1; }
done
grep -Fq 'run: bash ops/oracle/validate-cd-source.sh' "$WORKFLOW" || { echo 'FALLO: workflow no ejecuta el validador probado'; exit 1; }
grep -Fq 'tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd' "$WORKFLOW" || { echo 'FALLO: falta Tailscale OIDC'; exit 1; }
grep -Fq 'id-token: write' "$WORKFLOW" || { echo 'FALLO: falta permiso OIDC'; exit 1; }
grep -Fq "needs.prepare.outputs.services != '[]'" "$WORKFLOW" || { echo 'FALLO: release no requiere servicios seleccionados'; exit 1; }
echo "CORRECTO: workflow_run validado y workflow_dispatch manual preservado; Tailscale usa OIDC"

# 2. Invocación en modo automatic devuelve lista vacía [] y rechaza despliegues automáticos
auto_output="$(bash "$SELECTOR" automatic example/g6-backend 2>&1)"
[[ "$auto_output" =~ "[]" ]] || {
  echo "FALLO: modo automatic no devolvió []: $auto_output" >&2
  exit 1
}
[[ "$auto_output" == '[]' ]] || { echo 'FALLO: con los nueve flags false, automatic debe ser un no-op'; exit 1; }
echo "CORRECTO: modo automatic devuelve [] mientras los nueve servicios están deshabilitados"

# 3. CI fallida impide liberación
grep -Fq 'gh run list --repo "$repository" --workflow ci.yml --branch master --commit "$sha"' "$SOURCE_VALIDATOR" || {
  echo "FALLO: falta consulta de CI push exitoso en master" >&2
  exit 1
}
grep -Fq 'No se encontró una ejecución CI de push exitosa para el commit de master' "$SOURCE_VALIDATOR" || {
  echo "FALLO: falta mensaje y aborto ante CI no exitosa" >&2
  exit 1
}
echo "CORRECTO: commit sin CI push exitosa en master impide la liberación"

# 4. SHA diferente al master vigente o inválido impide liberación
grep -Fq 'repos/${repository}/commits/master' "$SOURCE_VALIDATOR" || {
  echo "FALLO: falta verificación de HEAD vigente de master" >&2
  exit 1
}
grep -Fq 'OMITIDO: revisión obsoleta' "$SOURCE_VALIDATOR" || {
  echo "FALLO: falta descarte de commit obsoleto" >&2
  exit 1
}
grep -Fq '^[0-9a-f]{40}$' "$SOURCE_VALIDATOR" || {
  echo "FALLO: falta validación estricta de formato SHA de 40 caracteres" >&2
  exit 1
}
grep -Fq 'Confirmar que el commit sigue siendo la punta de master' "$WORKFLOW" || {
  echo "FALLO: falta re-verificación de frescura de master antes de SSH" >&2
  exit 1
}
echo "CORRECTO: SHA obsoleto, desactualizado o con formato inválido impide la liberación"

# 5. Secretos faltantes: fallo seguro, sin despliegue
grep -Fq 'Validar secretos de despliegue' "$WORKFLOW" || {
  echo "FALLO: falta paso Validar secretos de despliegue" >&2
  exit 1
}
for secret in ORACLE_HOST ORACLE_USER ORACLE_SSH_PRIVATE_KEY ORACLE_SSH_KNOWN_HOSTS ORACLE_GHCR_USERNAME ORACLE_GHCR_TOKEN TS_OIDC_CLIENT_ID TS_OIDC_AUDIENCE; do
  grep -Fq "$secret" "$WORKFLOW" || {
    echo "FALLO: secreto obligatorio $secret ausente en validación" >&2
    exit 1
  }
done
grep -Fq 'Falta configurar el secreto o variable de GitHub $name; se detiene el CD Oracle antes de publicar.' "$WORKFLOW" || {
  echo "FALLO: falta mensaje de salida segura ante secretos faltantes" >&2
  exit 1
}
validation_line="$(grep -n 'name: Validar secretos de despliegue y variables Tailscale' "$WORKFLOW" | cut -d: -f1)"
publish_line="$(grep -n 'name: Construir y publicar imagen etiquetada con SHA' "$WORKFLOW" | cut -d: -f1)"
((validation_line < publish_line)) || { echo 'FALLO: se publicaría antes de validar secretos/OIDC.' >&2; exit 1; }
echo "CORRECTO: ejecución fail-closed garantizada si faltan secretos"

# 6. Controles SSH, Deployments API y Rollback
grep -Fq 'ssh -vv -i ~/.ssh/oracle_g6 -o BatchMode=yes -o IdentitiesOnly=yes' "$WORKFLOW" || {
  echo "FALLO: falta probe restringido SSH" >&2
  exit 1
}
grep -Fq 'comando remoto no autorizado' "$WORKFLOW" || {
  echo "FALLO: falta verificación del comando remoto forzado en SSH" >&2
  exit 1
}
grep -Fq 'github-deployment-api.sh create' "$WORKFLOW" || {
  echo "FALLO: falta registro de inicio de Deployment" >&2
  exit 1
}
grep -Fq 'github-deployment-api.sh status "$GITHUB_REPOSITORY" "$DEPLOYMENT_ID" success' "$WORKFLOW" || {
  echo "FALLO: falta registro de éxito en Deployment tras SSH" >&2
  exit 1
}
grep -Fq 'github-deployment-api.sh status "$GITHUB_REPOSITORY" "$DEPLOYMENT_ID" failure' "$WORKFLOW" || {
  echo "FALLO: falta registro de fallo en Deployment" >&2
  exit 1
}
deploy_line="$(grep -n 'name: Desplegar imagen, comprobar salud y recuperar ante fallo' "$WORKFLOW" | cut -d: -f1)"
success_line="$(grep -n 'name: Registrar despliegue exitoso después de comprobar salud remota' "$WORKFLOW" | cut -d: -f1)"
((success_line > deploy_line)) || {
  echo "FALLO: éxito se registraría antes de completar el despliegue remoto" >&2
  exit 1
}
echo "CORRECTO: pipeline SSH, healthchecks, deployments y rollback estructurados correctamente"
