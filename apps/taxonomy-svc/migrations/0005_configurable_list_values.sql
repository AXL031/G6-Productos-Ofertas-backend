-- Migración aditiva: el límite físico y el servicio comparten el ajuste SPEC-009.
INSERT INTO taxonomy.runtime_settings (clave, valor_integer, descripcion)
VALUES ('MAX_ACTIVE_LIST_VALUES', 50, 'Máximo de valores LISTA activos por característica')
ON CONFLICT (clave) DO NOTHING;

CREATE OR REPLACE FUNCTION taxonomy.fn_enforce_characteristic_value_rules()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_tipo taxonomy.tipo_caracteristica;
    v_activos integer;
    v_limite integer;
BEGIN
    SELECT tipo INTO v_tipo FROM taxonomy.characteristics
    WHERE id = NEW.caracteristica_id FOR UPDATE;
    IF v_tipo <> 'LISTA' THEN
        RAISE EXCEPTION 'Solo las características de tipo LISTA pueden tener valores predefinidos. Tipo actual: %', v_tipo;
    END IF;
    IF NEW.estado = 'ACTIVO' THEN
        SELECT valor_integer INTO v_limite FROM taxonomy.runtime_settings
        WHERE clave = 'MAX_ACTIVE_LIST_VALUES' FOR UPDATE;
        IF v_limite IS NULL OR v_limite < 1 THEN
            RAISE EXCEPTION 'Configuración MAX_ACTIVE_LIST_VALUES inválida';
        END IF;
        SELECT count(*) INTO v_activos FROM taxonomy.characteristic_values
        WHERE caracteristica_id = NEW.caracteristica_id AND estado = 'ACTIVO'
          AND id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
        IF v_activos >= v_limite THEN
            RAISE EXCEPTION 'Límite alcanzado: máximo % valores activos', v_limite;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
