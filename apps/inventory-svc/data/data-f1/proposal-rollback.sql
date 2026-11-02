-- ============================================================================
-- SCRIPT DE REVERSIÓN SELECTIVA SEGURA — DATA-004 (ISSUE #14)
-- ============================================================================
-- Microservicio: inventory-svc
-- Esquema destino: inventory
-- Ambiente: Supabase compartido G6 (slzglmtiyrzygpkiuthf), PostgreSQL 17
-- PROPÓSITO:
--   Elimina de forma segura y selectiva ÚNICAMENTE los 2 umbrales de stock
--   introducidos por DATA-004 (umbral global 5 y específico 3 para ADI-ENT22-AZU-M).
--   Garantiza que no se afecten saldos, ubicaciones, operaciones ni Kardex.
-- ============================================================================
-- MECANISMO DE EJECUCIÓN:
-- 1. Desde psql:
--      psql -v ON_ERROR_STOP=1 -f apps/inventory-svc/data/data-f1/proposal-rollback.sql
-- 2. Desde el Editor SQL de Supabase:
--      Copiar y ejecutar el bloque transaccional completo.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Verificación de destino
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'inventory'
  ) THEN
    RAISE EXCEPTION 'Destino inválido: esquema inventory no encontrado en base %', current_database();
  END IF;
END $$;

SET LOCAL search_path = inventory, public;

-- Adquirir lock transaccional consultivo para serializar reversiones concurrentes
SELECT pg_advisory_xact_lock(hashtext('inventory.data-004.thresholds'));

-- ----------------------------------------------------------------------------
-- 2. Eliminación selectiva acotada estrictamente a las identidades de DATA-004
-- ----------------------------------------------------------------------------
-- Elimina única y exclusivamente los registros con los UUIDs deterministas asignados a DATA-004
-- y cuyo contenido coincida con la definición de la carga, preservando cualquier umbral
-- preexistente o creado por otros procesos bajo otros identificadores.
DELETE FROM inventory.stock_threshold_override
WHERE id IN (
  '0a24fa68-450f-5fa1-827d-78fb5f09fe54'::uuid,
  '7b49463c-333e-5e63-b8ad-344c20847250'::uuid
)
AND (
  (id = '0a24fa68-450f-5fa1-827d-78fb5f09fe54'::uuid AND sku_id IS NULL AND location_id IS NULL AND umbral_efectivo = 5)
  OR
  (id = '7b49463c-333e-5e63-b8ad-344c20847250'::uuid AND sku_id = 'ADI-ENT22-AZU-M' AND location_id IS NULL AND umbral_efectivo = 3)
);

-- ----------------------------------------------------------------------------
-- 3. Verificación de no regresión sobre saldos existentes
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_balances integer;
  v_locations integer;
BEGIN
  -- Validar que permanezcan intactos los 14 saldos existentes
  SELECT count(*) INTO v_balances
  FROM inventory.stock_balance
  WHERE location_id IN (
    '9129b578-631e-1735-8427-b683fb524380'::uuid,
    'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'::uuid
  );

  IF v_balances <> 14 THEN
    RAISE EXCEPTION 'Reversión abortada: se detectó alteración en los 14 saldos existentes (total actual: %)', v_balances;
  END IF;

  -- Validar que permanezcan intactas las 2 ubicaciones
  SELECT count(*) INTO v_locations
  FROM inventory.locations
  WHERE id IN (
    '9129b578-631e-1735-8427-b683fb524380'::uuid,
    'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'::uuid
  );

  IF v_locations <> 2 THEN
    RAISE EXCEPTION 'Reversión abortada: se detectó alteración en las 2 ubicaciones autorizadas (total actual: %)', v_locations;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. Confirmación de la reversión
-- ----------------------------------------------------------------------------
COMMIT;
