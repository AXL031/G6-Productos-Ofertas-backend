-- SPEC-010: admitir o rechazar una baja no modifica el esquema efectivo.
-- Conserva el incremento para cambios confirmados y de obligatoriedad.
CREATE OR REPLACE FUNCTION taxonomy.fn_bump_product_type_schema_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_tipo_producto_id uuid;
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.obligatoria IS NOT DISTINCT FROM NEW.obligatoria
       AND ((OLD.estado = 'ACTIVO' AND NEW.estado = 'PENDING_DEACTIVATION')
         OR (OLD.estado = 'PENDING_DEACTIVATION' AND NEW.estado = 'ACTIVO')) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        v_tipo_producto_id := OLD.tipo_producto_id;
    ELSE
        v_tipo_producto_id := NEW.tipo_producto_id;
    END IF;

    UPDATE taxonomy.product_types
    SET schema_version = schema_version + 1,
        updated_at = now()
    WHERE id = v_tipo_producto_id;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
