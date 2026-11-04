-- Preparación autorizada en esta sesión; NO aplicada a Supabase.
-- Ejecutar únicamente mediante el proceso aprobado de migración/ledger, bajo owner.
DO $$ BEGIN
  IF current_user <> 'po_price_audit_owner' THEN
    RAISE EXCEPTION 'Ejecutar con po_price_audit_owner';
  END IF;
END $$;
ALTER TABLE price_audit.price_audit_log
  ADD COLUMN target_type text NOT NULL DEFAULT 'SKU',
  ALTER COLUMN sku DROP NOT NULL,
  ALTER COLUMN canal_origen DROP NOT NULL,
  ALTER COLUMN precio_anterior TYPE numeric,
  ALTER COLUMN precio_nuevo TYPE numeric,
  DROP CONSTRAINT ck_price_audit_log_null_semantics,
  ADD CONSTRAINT ck_price_audit_log_target CHECK (
    (target_type = 'PRODUCTO' AND sku IS NULL) OR
    (target_type = 'SKU' AND sku IS NOT NULL AND length(sku) > 0)),
  ADD CONSTRAINT ck_price_audit_log_null_semantics CHECK (
    (tipo_operacion = 'CREACION' AND precio_anterior IS NULL AND precio_nuevo IS NOT NULL AND variacion_porcentual IS NULL) OR
    (tipo_operacion = 'MODIFICACION' AND precio_anterior IS NOT NULL AND precio_nuevo IS NOT NULL AND (precio_anterior = 0 OR variacion_porcentual IS NOT NULL)) OR
    (tipo_operacion = 'RETIRO_OFERTA' AND tipo_precio = 'OFERTA' AND precio_anterior IS NOT NULL AND precio_nuevo IS NULL AND variacion_porcentual IS NULL));
