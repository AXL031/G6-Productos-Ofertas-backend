-- Ejecutar por el owner mediante el proceso de migraciones, nunca en bootstrap.
-- Sin backfill: toda fila preexistente conserva NULL (historial desconocido).
DO $$ BEGIN
    IF current_user <> 'po_catalog_owner' THEN
        RAISE EXCEPTION 'Catalog migration requires po_catalog_owner' USING ERRCODE = '42501';
    END IF;
END $$;
ALTER TABLE catalog.products ADD COLUMN publicado_alguna_vez boolean;
ALTER TABLE catalog.products ALTER COLUMN publicado_alguna_vez SET DEFAULT false;

CREATE FUNCTION catalog.guard_product_publication_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, catalog AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.publicado_alguna_vez := false;
    ELSE
        IF OLD.publicado_alguna_vez IS TRUE AND NEW.publicado_alguna_vez IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'PUBLICATION_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
        END IF;
        IF OLD.estado = 'BORRADOR' AND NEW.estado = 'ACTIVO' THEN
            NEW.publicado_alguna_vez := true;
        ELSIF NEW.publicado_alguna_vez IS DISTINCT FROM OLD.publicado_alguna_vez THEN
            RAISE EXCEPTION 'PUBLICATION_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_publication_history
BEFORE INSERT OR UPDATE ON catalog.products FOR EACH ROW
EXECUTE FUNCTION catalog.guard_product_publication_history();
REVOKE ALL ON FUNCTION catalog.guard_product_publication_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.guard_product_publication_history() TO catalog_app;
COMMENT ON COLUMN catalog.products.publicado_alguna_vez IS
'Q-06: false nuevo, true primera transicion BORRADOR-ACTIVO confirmada, NULL historico desconocido. true irreversible.';
