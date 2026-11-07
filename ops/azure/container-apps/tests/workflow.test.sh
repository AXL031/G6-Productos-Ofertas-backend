#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
readonly ROOT
readonly WORKFLOW="$ROOT/.github/workflows/cd-services-azure.yml"
readonly CI_WORKFLOW="$ROOT/.github/workflows/ci.yml"
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
for required in "workflow_run:" "workflow_dispatch:" "environment: azure-h4" "id-token: write" "cancel-in-progress: false" "max-parallel: 1" "packages: write" "azure/login@v2" "container-apps/deploy.sh" "smoke-marketplace.sh" "  recover:" "needs: [prepare, deploy, smoke]" "needs.smoke.result == 'failure'" "if: always()" "Recuperación supervisada" "reconcile-recovery.sh" "needs.prepare.outputs.services" "gh api"; do
  grep -Fq "$required" "$WORKFLOW" || fail "falta $required"
done
if grep -Fq '  push:' "$WORKFLOW"; then fail 'CD no debe publicarse desde push no validado'; fi
grep -Fq "github.repository == 'Taller-SW-Web/G6-Productos-Ofertas-backend'" "$WORKFLOW" || fail 'repositorio oficial no fijado'
grep -Fq 'ops/azure/container-apps/validate-source.sh' "$WORKFLOW" || fail 'validación de procedencia ausente'
grep -Fq 'actions: read' "$WORKFLOW" || fail 'lectura de ejecuciones CI ausente'
# The GitHub expressions are searched literally to match the public publisher's lock group.
# shellcheck disable=SC2016
grep -Fq 'deploy-g6-services-oracle-${{ github.repository }}-${{ matrix.service }}' "$WORKFLOW" || fail 'publicación no serializada con el publicador oficial por servicio'
for forbidden in 'AZURE_CLIENT_SECRET' 'AZURE_PASSWORD' 'ARM_CLIENT_SECRET' ':latest' 'az containerapp create' 'az containerapp delete'; do
  if grep -Fq "$forbidden" "$WORKFLOW"; then fail "capacidad/credencial prohibida: $forbidden"; fi
done
for service in api-gateway catalog-svc taxonomy-svc inventory-svc combos-svc promotions-svc pricing-svc price-audit-svc bulk-svc; do
  grep -Fq -- "- $service" "$WORKFLOW" || fail "faltó el servicio $service"
done
grep -Fq 'SMOKE_MAX_ATTEMPTS:-6' "$ROOT/ops/azure/container-apps/smoke-marketplace.sh" || fail 'reintentos HTTPS por defecto no acotados'
grep -Fq 'Reintento %s/%s' "$ROOT/ops/azure/container-apps/smoke-marketplace.sh" || fail 'reintentos HTTPS no registrados'
grep -Fq 'DEPLOY_RECEIPT' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'recibo para recuperación coordinada ausente'
grep -Fq -- '--restore' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'modo de recuperación por digest ausente'
grep -Fq 'select(.name == "caddy")' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'identidad efectiva caddy minúscula no validada'
grep -Fq 'del(.revisionSuffix)' "$ROOT/ops/azure/container-apps/deploy.sh" || fail 'metadato revisionSuffix no normalizado'
grep -Fq 'containerApps/write' "$ROOT/ops/azure/container-apps/CONFIGURACION_OIDC_H4.md" || fail 'limitación del permiso genérico write no documentada'
grep -Fq 'azure_cd_h4:' "$CI_WORKFLOW" || fail 'pruebas del ejecutor no conectadas a CI'
for test_file in validate-source.test.sh deploy.test.sh smoke.test.sh reconcile-recovery.test.sh workflow.test.sh; do
  grep -Fq "ops/azure/container-apps/tests/$test_file" "$CI_WORKFLOW" || fail "CI no ejecuta $test_file"
done
printf 'PASS: workflow separa auto/manual, publica, usa OIDC, limita Azure y serializa despliegues\n'
