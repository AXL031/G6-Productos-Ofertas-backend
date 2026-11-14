-- ============================================================================
-- AUDITORÍA DE SOLO LECTURA — DATA-004 (ISSUE #14)
-- ============================================================================
-- Destino: Supabase compartido G6 (slzglmtiyrzygpkiuthf), PostgreSQL 17
-- Esquema: inventory
-- Propósito: Verificación previa no invasiva de precondiciones antes de proposal-load.sql.
-- Uso administrativo exclusivo; no modifica ningún dato ni esquema.
-- ============================================================================

SELECT jsonb_build_object(
  'audited_at', now(),
  'database', current_database(),
  'schema', 'inventory',
  'locations', (
    SELECT jsonb_agg(l ORDER BY code)
    FROM inventory.locations l
  ),
  'locations_count', (
    SELECT count(*) FROM inventory.locations WHERE active = true
  ),
  'stock_balances', (
    SELECT jsonb_agg(b ORDER BY sku_id, location_id)
    FROM inventory.stock_balance b
  ),
  'stock_balances_count', (
    SELECT count(*) FROM inventory.stock_balance
  ),
  'existing_thresholds', (
    SELECT COALESCE(jsonb_agg(t ORDER BY id), '[]'::jsonb)
    FROM inventory.stock_threshold_override t
  ),
  'existing_thresholds_count', (
    SELECT count(*) FROM inventory.stock_threshold_override
  ),
  'operations_count', (
    SELECT count(*) FROM inventory.inventory_operations
  ),
  'kardex_count', (
    SELECT count(*) FROM inventory.kardex
  )
) AS inventory_audit_preflight;
