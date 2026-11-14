#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/cd-services-azure.yml"
CI_WORKFLOW="$ROOT/.github/workflows/ci.yml"
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
for required in 'workflow_dispatch:' 'environment: azure-h5' 'id-token: write' 'cancel-in-progress: false' 'max-parallel: 1' 'packages: write' 'azure/login@v2' 'container-apps/deploy.sh' 'smoke-service.sh' 'reconcile-recovery.sh' 'g6-azure-h5-' 'publish-g6-ghcr-' 'ops/shared/ensure-ghcr-sha-image.sh'; do
  grep -Fq "$required" "$WORKFLOW" || fail "falta $required"
done
if grep -Eq '^[[:space:]]+workflow_run:' "$WORKFLOW"; then fail 'CD no debe desplegar automáticamente'; fi
if grep -Fq 'ops/oracle/' "$WORKFLOW"; then fail 'CD Azure conserva dependencia operativa Oracle'; fi
grep -Fq "github.repository == 'Taller-SW-Web/G6-Productos-Ofertas-backend'" "$WORKFLOW" || fail 'repositorio oficial no fijado'
grep -Fq 'ops/azure/container-apps/validate-source.sh' "$WORKFLOW" || fail 'validación de procedencia ausente'
grep -Fq 'actions: read' "$WORKFLOW" || fail 'lectura de ejecuciones CI ausente'
grep -Fq 'AZURE_SMOKE_PROTECTED_CATALOG_SVC' "$WORKFLOW" || fail 'smoke de rechazo sin credenciales no configurable'
grep -Fq 'needs: [prepare, security]' "$WORKFLOW" || fail 'publicación no depende del gate de seguridad'
grep -Fq 'npm audit --omit=dev --audit-level=high' "$WORKFLOW" || fail 'gate obligatorio de auditoría de producción ausente'
grep -Fq 'verify-environment-protection.sh' "$WORKFLOW" || fail 'preflight de protección del environment ausente'
grep -Fq 'verify-environment-protection.test.sh' "$CI_WORKFLOW" || fail 'CI no prueba la protección real del environment'
grep -Fq 'runs-on: [self-hosted, linux, azure-h5-smoke]' "$WORKFLOW" || fail 'smoke no se ejecuta desde runner de red autorizada'
deploy_gate_line="$(grep -nF 'Verificar reglas reales del environment antes de OIDC' "$WORKFLOW" | head -n 1 | cut -d: -f1)"
deploy_login_line="$(grep -nF 'Autenticar en Azure mediante OIDC' "$WORKFLOW" | head -n 1 | cut -d: -f1)"
recovery_gate_line="$(grep -nF 'Verificar reglas reales del environment antes de autenticarse' "$WORKFLOW" | head -n 1 | cut -d: -f1)"
recovery_login_line="$(grep -nF 'Autenticar en Azure mediante OIDC para recuperación' "$WORKFLOW" | head -n 1 | cut -d: -f1)"
[[ -n "$deploy_gate_line" && -n "$deploy_login_line" && "$deploy_gate_line" -lt "$deploy_login_line" ]] || fail 'el deploy autentica antes de verificar protección'
[[ -n "$recovery_gate_line" && -n "$recovery_login_line" && "$recovery_gate_line" -lt "$recovery_login_line" ]] || fail 'la recuperación autentica antes de verificar protección'
for forbidden in 'AZURE_CLIENT_SECRET' 'AZURE_PASSWORD' 'ARM_CLIENT_SECRET' ':latest' 'az containerapp create' 'az containerapp delete'; do
  if grep -Fq "$forbidden" "$WORKFLOW"; then fail "capacidad/credencial prohibida: $forbidden"; fi
done
for service in api-gateway bulk-svc catalog-svc combos-svc inventory-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc; do
  grep -Fq -- "- $service" "$WORKFLOW" || fail "faltó el servicio $service"
  service_key="${service^^}"
  service_key="${service_key//-/_}"
  grep -Fq "SMOKE_URL_${service_key}" "$WORKFLOW" || fail "faltó la variable smoke de $service"
done
grep -Fq 'DEPLOY_RECEIPT' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'recibo para recuperación coordinada ausente'
grep -Fq -- '--restore' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'modo de recuperación por digest ausente'
grep -Fq 'select(.name == "caddy")' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'identidad efectiva Caddy no validada'
grep -Fq 'del(.revisionSuffix)' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'metadato revisionSuffix no normalizado'
grep -Fq 'containerApps/write' "$ROOT/ops/azure/container-apps/CONFIGURACION_OIDC_H5.md" || fail 'límite del permiso genérico write no documentado'
grep -Fq 'azure_cd_h5:' "$CI_WORKFLOW" || fail 'pruebas de ejecutor H5 no conectadas a CI'
for test_file in validate-source.test.sh verify-environment-protection.test.sh deploy.test.sh smoke.test.sh reconcile-recovery.test.sh workflow.test.sh; do
  grep -Fq "ops/azure/container-apps/tests/$test_file" "$CI_WORKFLOW" || fail "CI no ejecuta $test_file"
done
grep -Fq 'ops/shared/tests/ensure-ghcr-sha-image.test.sh' "$CI_WORKFLOW" || fail 'CI no prueba el helper neutral de GHCR'
printf 'PASS: CD Azure H5 es manual, aplica gates explícitos, no depende de Oracle y cubre nueve servicios\n'
