#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/artifacts"
target='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/taxonomy-svc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
previous='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/taxonomy-svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
printf '%s\n' "$target" > "$TEMP/artifacts/image-taxonomy-svc.txt"
printf '%s\n' 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' > "$TEMP/artifacts/image-inventory-svc.txt"
printf '%s\n' 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/combos-svc@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' > "$TEMP/artifacts/image-combos-svc.txt"
printf '%s\n' 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/promotions-svc@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' > "$TEMP/artifacts/image-promotions-svc.txt"
printf '%s\n' 'service=taxonomy-svc' "previous=$previous" "target=$target" 'config_sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' > "$TEMP/artifacts/taxonomy-svc.receipt"
printf '%s\n' 'service=combos-svc' 'previous=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/combos-svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "target=$(cat "$TEMP/artifacts/image-combos-svc.txt")" 'config_sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' > "$TEMP/artifacts/combos-svc.receipt"

cat > "$TEMP/jobs.json" <<'JOBS'
{"jobs":[
 {"name":"Desplegar catalog-svc en Azure","conclusion":"skipped","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"skipped"}]},
 {"name":"Desplegar taxonomy-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]},
 {"name":"Desplegar inventory-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]},
 {"name":"Desplegar combos-svc en Azure","conclusion":"failure","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"failure"}]},
 {"name":"Desplegar promotions-svc en Azure","conclusion":"failure","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"failure"}]},
 {"name":"Desplegar price-audit-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]},
 {"name":"Desplegar bulk-svc en Azure","conclusion":"skipped","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"skipped"}]}
]}
JOBS

cat > "$TEMP/deploy-stub.sh" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == --restore ]]; then
  if [[ "$2" == taxonomy-svc ]]; then echo 'ROLLBACK COORDINADO VERIFICADO'; exit 0; fi
  echo 'RECUPERACIÓN OMITIDA: drift'; exit 1
fi
if [[ "$1" == --inspect ]]; then
  if [[ "$2" == inventory-svc ]]; then echo 'TARGET_ACTIVE: inventory-svc'; exit 0; fi
  if [[ "$2" == promotions-svc ]]; then echo 'TARGET_NOT_ACTIVE: promotions-svc'; exit 0; fi
  echo 'INSPECTION_UNKNOWN'; exit 2
fi
exit 2
STUB
chmod +x "$TEMP/deploy-stub.sh"

if DEPLOY_SCRIPT="$TEMP/deploy-stub.sh" GITHUB_STEP_SUMMARY="$TEMP/partial.md" bash "$ROOT/ops/azure/container-apps/reconcile-recovery.sh" \
  '["catalog-svc","taxonomy-svc","inventory-svc","combos-svc","promotions-svc","price-audit-svc","bulk-svc"]' "$TEMP/artifacts" "$TEMP/jobs.json" > "$TEMP/partial.log" 2>&1; then
  echo 'FAIL: faltantes/desconocidos no pueden declarar recuperación completa' >&2
  exit 1
fi
for status in 'NO DESPLEGADO: catalog-svc' 'RECUPERADO: taxonomy-svc' 'ACTUALIZADO SIN RECIBO: inventory-svc' 'ESTADO DESCONOCIDO: combos-svc' 'ESTADO DESCONOCIDO: promotions-svc' 'ESTADO DESCONOCIDO: price-audit-svc' 'NO DESPLEGADO: bulk-svc' 'RECUPERACIÓN PARCIAL/DESCONOCIDA'; do
  grep -Fq "$status" "$TEMP/partial.log" || { cat "$TEMP/partial.log"; echo "FAIL: falta estado $status" >&2; exit 1; }
done
echo 'PASS: selección completa distingue no desplegado, con recibo, sin recibo, recuperado y desconocido'

cat > "$TEMP/jobs-skipped.json" <<'JOBS'
{"jobs":[
 {"name":"Desplegar catalog-svc en Azure","conclusion":"skipped","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"skipped"}]},
 {"name":"Desplegar taxonomy-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]}
]}
JOBS
DEPLOY_SCRIPT="$TEMP/deploy-stub.sh" GITHUB_STEP_SUMMARY="$TEMP/complete.md" bash "$ROOT/ops/azure/container-apps/reconcile-recovery.sh" \
  '["catalog-svc","taxonomy-svc"]' "$TEMP/artifacts" "$TEMP/jobs-skipped.json" > "$TEMP/complete.log" 2>&1 || { cat "$TEMP/complete.log"; exit 1; }
grep -Fq 'RECUPERACIÓN COMPLETA:' "$TEMP/complete.log"
echo 'PASS: solo recuperación verificada más servicios omitidos con evidencia permite completar'
