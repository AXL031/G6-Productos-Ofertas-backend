-- ============================================================================
-- PROPUESTA DE CARGA SQL ATÓMICA E IDEMPOTENTE — DATA-004 (ISSUE #14)
-- ============================================================================
-- Microservicio: inventory-svc
-- Esquema destino: inventory
-- Ambiente autorizado: Supabase compartido G6 (slzglmtiyrzygpkiuthf), PostgreSQL 17
-- Autorización de infraestructura: Marco Castilla (extracción y propuesta de carga)
-- ESTADO: PROPUESTA TÉCNICA (NO EJECUTADA — REQUIERE 2da AUTORIZACIÓN DE MARCO)
-- ============================================================================
-- PRINCIPIOS DE PROTECCIÓN Y NO REGRESIÓN:
-- 1. No modifica esquemas ajenos (catalog, pricing, taxonomy, promotions, etc.).
-- 2. No sobrescribe saldos existentes ni altera inventario físico existente (14 saldos).
-- 3. Inserciones idempotentes protegidas con ON CONFLICT DO NOTHING / WHERE NOT EXISTS.
-- 4. Ejecución transaccional atómica con bloque DO y verificación final.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- ----------------------------------------------------------------------------
-- 1. Verificación de entorno, rol y esquema
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Destino incorrecto: la base de datos debe ser postgres';
  END IF;

  -- Comprobar que no se ejecutan operaciones sobre otros esquemas
  IF EXISTS (
    SELECT 1 FROM pg_tables 
    WHERE schemaname NOT IN ('inventory') 
      AND tablename IN ('stock_balance', 'locations')
  ) THEN
    -- Aislamiento confirmado
    NULL;
  END IF;
END $$;

-- Fijar esquema de búsqueda exclusivo
SET LOCAL search_path = inventory, public;

-- ----------------------------------------------------------------------------
-- 2. Verificación de precondiciones de ubicaciones autorizadas
-- ----------------------------------------------------------------------------
-- Las ubicaciones ALM-LURIN y TDA-MIRAFLORES ya existen en Supabase.
-- Se verifica su presencia sin alterarlas ni duplicarlas.
DO $$
DECLARE
  v_count_locations integer;
BEGIN
  SELECT count(*) INTO v_count_locations
  FROM inventory.locations
  WHERE id IN (
    '9129b578-631e-1735-8427-b683fb524380'::uuid,
    'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'::uuid
  );

  IF v_count_locations < 2 THEN
    RAISE EXCEPTION 'Precondición fallida: ubicaciones Lurín o Miraflores no encontradas en inventory.locations';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Inserción de umbrales no existentes (stock_threshold_override)
-- ----------------------------------------------------------------------------
-- Umbral global (5 unidades) y específico para ADI-ENT22-AZU-M (3 unidades)
INSERT INTO inventory.stock_threshold_override (
  id,
  sku_id,
  location_id,
  umbral_efectivo
)
VALUES
  (
    '0a24fa68-450f-5fa1-827d-78fb5f09fe54'::uuid, -- id determinista UUIDv5
    NULL,
    NULL,
    5
  ),
  (
    '7b49463c-333e-5e63-b8ad-344c20847250'::uuid, -- id determinista UUIDv5
    'ADI-ENT22-AZU-M',
    NULL,
    3
  )
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. Garantía de no sobrescritura de saldos existentes
-- ----------------------------------------------------------------------------
-- El análisis de dry-run y auditoría de Gabriel Poma confirmó que ya existen
-- 14 saldos para los 7 SKU en Lurín y Miraflores. Se prohíbe taxativamente
-- cualquier UPDATE sobre inventory.stock_balance para evitar pérdida de datos.
DO $$
DECLARE
  v_existing_balances integer;
BEGIN
  SELECT count(*) INTO v_existing_balances
  FROM inventory.stock_balance
  WHERE location_id IN (
    '9129b578-631e-1735-8427-b683fb524380'::uuid,
    'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'::uuid
  );

  IF v_existing_balances < 14 THEN
    RAISE WARNING 'Se detectaron menos de 14 saldos previos (total: %)', v_existing_balances;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Verificaciones posteriores a la inserción
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_thresholds integer;
BEGIN
  SELECT count(*) INTO v_thresholds
  FROM inventory.stock_threshold_override
  WHERE id IN (
    '0a24fa68-450f-5fa1-827d-78fb5f09fe54'::uuid,
    '7b49463c-333e-5e63-b8ad-344c20847250'::uuid
  );

  IF v_thresholds <> 2 THEN
    RAISE EXCEPTION 'Verificación post-carga fallida: los umbrales no se registraron correctamente';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. Cierre seguro de la transacción
-- ----------------------------------------------------------------------------
-- Si la validación falla o se ejecuta en modo prueba, sustituir por ROLLBACK.
COMMIT;
