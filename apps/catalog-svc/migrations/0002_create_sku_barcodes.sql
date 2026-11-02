-- D-CAT-01..04 candidate additive migration. Run separately as po_catalog_owner.
-- Never executed by application startup. Historical 0001 remains immutable.
DO $guard$
BEGIN
  IF current_user <> 'po_catalog_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'catalog'
      AND pg_get_userbyid(nspowner) = current_user
  ) THEN RAISE EXCEPTION 'Require catalog owner'; END IF;
END
$guard$;

CREATE TABLE catalog.sku_barcodes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    codigo_barras text COLLATE "C" NOT NULL,
    sku_identity_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by text NOT NULL,
    retired_at timestamptz,
    retired_by text,
    CONSTRAINT pk_sku_barcodes PRIMARY KEY (id),
    CONSTRAINT uq_sku_barcodes_code UNIQUE (codigo_barras),
    CONSTRAINT fk_sku_barcodes_identity FOREIGN KEY (sku_identity_id)
      REFERENCES catalog.sku_identity(id) ON DELETE RESTRICT,
    CONSTRAINT ck_sku_barcodes_code CHECK (length(codigo_barras) > 0),
    CONSTRAINT ck_sku_barcodes_actor CHECK (length(created_by) > 0),
    CONSTRAINT ck_sku_barcodes_retirement CHECK (
      (retired_at IS NULL AND retired_by IS NULL) OR
      (retired_at IS NOT NULL AND retired_by IS NOT NULL AND length(retired_by) > 0 AND retired_at >= created_at)
    )
);
CREATE INDEX ix_sku_barcodes_identity ON catalog.sku_barcodes(sku_identity_id);

CREATE FUNCTION catalog.guard_sku_barcode() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, catalog AS $body$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Barcode history cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.codigo_barras IS DISTINCT FROM OLD.codigo_barras OR
       NEW.sku_identity_id IS DISTINCT FROM OLD.sku_identity_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.created_by IS DISTINCT FROM OLD.created_by OR
       (OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retired_by IS DISTINCT FROM OLD.retired_by)) THEN
      RAISE EXCEPTION 'Barcode identity and retirement are immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM catalog.sku_identity si
      LEFT JOIN catalog.variants v ON v.id = si.variant_id
      JOIN catalog.products p ON p.id = COALESCE(si.product_id, v.product_id)
      WHERE si.id = NEW.sku_identity_id AND
        ((si.product_id IS NOT NULL AND NOT p.tiene_variantes) OR
         (si.variant_id IS NOT NULL AND p.tiene_variantes))
    ) THEN RAISE EXCEPTION 'Require sellable SKU' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER trg_sku_barcode_guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.sku_barcodes
FOR EACH ROW EXECUTE FUNCTION catalog.guard_sku_barcode();
REVOKE ALL ON catalog.sku_barcodes FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.guard_sku_barcode() FROM PUBLIC;
GRANT SELECT ON catalog.sku_barcodes TO catalog_app;
GRANT INSERT(codigo_barras, sku_identity_id, created_by) ON catalog.sku_barcodes TO catalog_app;
GRANT UPDATE(retired_at, retired_by) ON catalog.sku_barcodes TO catalog_app;
GRANT EXECUTE ON FUNCTION catalog.guard_sku_barcode() TO catalog_app;
