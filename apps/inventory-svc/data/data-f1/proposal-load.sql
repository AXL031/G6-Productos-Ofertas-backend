-- ============================================================================
-- PROPUESTA DE CARGA SQL ATÓMICA E IDEMPOTENTE — DATA-004 (ISSUE #14)
-- ============================================================================
-- Microservicio: inventory-svc
-- Esquema destino: inventory
-- Ambiente autorizado: Supabase compartido G6 (slzglmtiyrzygpkiuthf), PostgreSQL 17
-- Autorización de infraestructura: Marco Castilla (extracción y propuesta técnica)
-- ESTADO: PROPUESTA TÉCNICA (NO EJECUTADA — REQUIERE 2da AUTORIZACIÓN DE MARCO)
-- ============================================================================
-- MECANISMO DE EJECUCIÓN ADMITIDO:
-- 1. Desde psql:
--      psql -v ON_ERROR_STOP=1 -f apps/inventory-svc/data/data-f1/proposal-load.sql
-- 2. Desde el Editor SQL de Supabase:
--      Copiar y ejecutar el bloque completo; el script es SQL puro y transaccional.
-- ============================================================================
-- PRINCIPIOS DE PROTECCIÓN Y NO REGRESIÓN:
-- 1. No modifica esquemas ajenos (catalog, pricing, taxonomy, promotions, etc.).
-- 2. No sobrescribe saldos existentes ni altera inventario físico (14 saldos).
-- 3. Idempotencia estricta por clave de negocio funcional (WHERE NOT EXISTS).
-- 4. Aborta con RAISE EXCEPTION ante cualquier discrepancia previa o posterior.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Verificación efectiva de destino y esquema
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- Validar existencia del esquema inventory
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'inventory'
  ) THEN
    RAISE EXCEPTION 'Destino inválido: el esquema inventory no existe en la base de datos %', current_database();
  END IF;

  -- Validar existencia de la tabla destino stock_threshold_override
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'inventory' AND table_name = 'stock_threshold_override'
  ) THEN
    RAISE EXCEPTION 'Destino inválido: la tabla inventory.stock_threshold_override no existe';
  END IF;
END $$;

-- Fijar search_path exclusivo para evitar ambigüedades de resolución
SET LOCAL search_path = inventory, public;

-- Adquirir lock transaccional consultivo para serializar ejecuciones concurrentes
-- y prevenir colisiones de clave única en WHERE NOT EXISTS
SELECT pg_advisory_xact_lock(hashtext('inventory.data-004.thresholds'));

-- ----------------------------------------------------------------------------
-- 2. Verificación estricta de precondiciones (Baseline real de Supabase)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count_locations integer;
  v_count_balances integer;
  v_conflicting_global integer;
  v_conflicting_sku integer;
BEGIN
  -- 2.1 Verificar exactamente las 2 ubicaciones autorizadas activas
  SELECT count(*) INTO v_count_locations
  FROM inventory.locations
  WHERE id IN (
    '9129b578-631e-1735-8427-b683fb524380'::uuid,
    'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'::uuid
  ) AND active = true;

  IF v_count_locations <> 2 THEN
    RAISE EXCEPTION 'Precondición fallida: se esperaban exactamente 2 ubicaciones activas (Lurín y Miraflores), encontradas: %', v_count_locations;
  END IF;

  -- 2.2 Verificar exactamente los 14 saldos existentes esperados
  SELECT count(*) INTO v_count_balances
  FROM inventory.stock_balance
  WHERE location_id IN (
    '9129b578-631e-1735-8427-b683fb524380'::uuid,
    'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'::uuid
  );

  IF v_count_balances <> 14 THEN
    RAISE EXCEPTION 'Precondición fallida: se esperaban exactamente 14 saldos en baseline, encontrados: %', v_count_balances;
  END IF;

  -- 2.3 Verificar que no existan umbrales globales incompatibles
  SELECT count(*) INTO v_conflicting_global
  FROM inventory.stock_threshold_override
  WHERE sku_id IS NULL AND location_id IS NULL AND umbral_efectivo <> 5;

  IF v_conflicting_global > 0 THEN
    RAISE EXCEPTION 'Precondición fallida: ya existe un umbral global incompatible con valor distinto a 5';
  END IF;

  -- 2.4 Verificar que no existan umbrales incompatibles para ADI-ENT22-AZU-M
  SELECT count(*) INTO v_conflicting_sku
  FROM inventory.stock_threshold_override
  WHERE sku_id = 'ADI-ENT22-AZU-M' AND location_id IS NULL AND umbral_efectivo <> 3;

  IF v_conflicting_sku > 0 THEN
    RAISE EXCEPTION 'Precondición fallida: ya existe un umbral incompatible para ADI-ENT22-AZU-M con valor distinto a 3';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Inserción idempotente por clave de negocio funcional
-- ----------------------------------------------------------------------------

-- 3.1 Umbral global (5 unidades)
-- Se inserta únicamente si no existe ya un umbral global en inventory.stock_threshold_override
INSERT INTO inventory.stock_threshold_override (
  id,
  sku_id,
  location_id,
  umbral_efectivo
)
SELECT
  '0a24fa68-450f-5fa1-827d-78fb5f09fe54'::uuid,
  NULL,
  NULL,
  5
WHERE NOT EXISTS (
  SELECT 1 FROM inventory.stock_threshold_override
  WHERE sku_id IS NULL AND location_id IS NULL
);

-- 3.2 Umbral específico para ADI-ENT22-AZU-M (3 unidades)
-- Se inserta únicamente si no existe ya un umbral para este SKU
INSERT INTO inventory.stock_threshold_override (
  id,
  sku_id,
  location_id,
  umbral_efectivo
)
SELECT
  '7b49463c-333e-5e63-b8ad-344c20847250'::uuid,
  'ADI-ENT22-AZU-M',
  NULL,
  3
WHERE NOT EXISTS (
  SELECT 1 FROM inventory.stock_threshold_override
  WHERE sku_id = 'ADI-ENT22-AZU-M' AND location_id IS NULL
);

-- ----------------------------------------------------------------------------
-- 4. Verificaciones transaccionales posteriores (Post-condiciones)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_global_val integer;
  v_sku_val integer;
  v_total_balances integer;
BEGIN
  -- 4.1 Verificar valor y presencia del umbral global
  SELECT umbral_efectivo INTO v_global_val
  FROM inventory.stock_threshold_override
  WHERE sku_id IS NULL AND location_id IS NULL;

  IF v_global_val IS NULL OR v_global_val <> 5 THEN
    RAISE EXCEPTION 'Post-verificación fallida: el umbral global debe ser 5, valor actual: %', v_global_val;
  END IF;

  -- 4.2 Verificar valor y presencia del umbral específico
  SELECT umbral_efectivo INTO v_sku_val
  FROM inventory.stock_threshold_override
  WHERE sku_id = 'ADI-ENT22-AZU-M' AND location_id IS NULL;

  IF v_sku_val IS NULL OR v_sku_val <> 3 THEN
    RAISE EXCEPTION 'Post-verificación fallida: el umbral de ADI-ENT22-AZU-M debe ser 3, valor actual: %', v_sku_val;
  END IF;

  -- 4.3 Garantizar que no se modificaron ni eliminaron los 14 saldos existentes
  SELECT count(*) INTO v_total_balances
  FROM inventory.stock_balance
  WHERE location_id IN (
    '9129b578-631e-1735-8427-b683fb524380'::uuid,
    'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'::uuid
  );

  IF v_total_balances <> 14 THEN
    RAISE EXCEPTION 'Post-verificación fallida: la cantidad de saldos existentes fue alterada (total: %)', v_total_balances;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Cierre seguro de la transacción
-- ----------------------------------------------------------------------------
COMMIT;
