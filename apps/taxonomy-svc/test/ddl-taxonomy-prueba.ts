import {
  AcreditacionInstanciaEfimera,
  BaseNoAisladaError,
} from './postgres-isolation.js';

export const ROL_PROPIETARIO = 'po_taxonomy_owner';
export const ROL_APP = 'taxonomy_app';
export const PASSWORD_APP = 'taxonomy_app_prueba';

const SENTENCIA_DROP = 'DROP SCHEMA IF EXISTS taxonomy CASCADE';

function exigirAcreditacion(acreditacion: AcreditacionInstanciaEfimera): void {
  if (!(acreditacion instanceof AcreditacionInstanciaEfimera)) {
    throw new BaseNoAisladaError(
      'DDL destructivo sin acreditación de instancia efímera verificada en vivo.',
    );
  }
}

export function construirSentenciaDropDdl(
  acreditacion: AcreditacionInstanciaEfimera,
): string {
  exigirAcreditacion(acreditacion);
  return SENTENCIA_DROP;
}

export function construirSentenciasDdl(
  acreditacion: AcreditacionInstanciaEfimera,
): string[] {
  exigirAcreditacion(acreditacion);
  return [
    SENTENCIA_DROP,
    `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL_PROPIETARIO}') THEN CREATE ROLE ${ROL_PROPIETARIO} LOGIN; END IF; END $do$;`,
    `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL_APP}') THEN CREATE ROLE ${ROL_APP} LOGIN; END IF; END $do$;`,
    `ALTER ROLE ${ROL_APP} WITH LOGIN PASSWORD '${PASSWORD_APP}'`,
    `CREATE SCHEMA taxonomy AUTHORIZATION ${ROL_PROPIETARIO}`,
    "CREATE TYPE taxonomy.estado_entidad AS ENUM ('ACTIVO', 'INACTIVO', 'PENDING_DEACTIVATION')",
    "CREATE TYPE taxonomy.tipo_entidad_maestra AS ENUM ('CATEGORY', 'BRAND', 'CHARACTERISTIC', 'CHARACTERISTIC_VALUE', 'PRODUCT_TYPE', 'PRODUCT_TYPE_CHARACTERISTIC')",
    "CREATE TYPE taxonomy.estado_operacion_baja AS ENUM ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'FAILED')",
    "CREATE TYPE taxonomy.tipo_caracteristica AS ENUM ('TEXTO', 'NUMERO', 'LISTA')",
    `CREATE TABLE taxonomy.characteristics (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nombre text NOT NULL,
      tipo taxonomy.tipo_caracteristica NOT NULL, unidad_medida text NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO', taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_characteristics_nombre UNIQUE (nombre),
      CONSTRAINT ck_characteristics_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_characteristics_unidad_medida CHECK ((tipo = 'NUMERO' AND unidad_medida IS NOT NULL AND length(trim(unidad_medida)) > 0) OR (tipo <> 'NUMERO' AND unidad_medida IS NULL)),
      CONSTRAINT ck_characteristics_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.characteristic_values (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), caracteristica_id uuid NOT NULL, nombre text NOT NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO', taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fk_characteristic_values_caracteristica FOREIGN KEY (caracteristica_id) REFERENCES taxonomy.characteristics(id) ON DELETE RESTRICT,
      CONSTRAINT uq_characteristic_values_nombre UNIQUE (caracteristica_id, nombre),
      CONSTRAINT ck_characteristic_values_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_characteristic_values_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.product_types (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nombre text NOT NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO', schema_version bigint NOT NULL DEFAULT 1,
      taxonomy_version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_product_types_nombre UNIQUE (nombre), CONSTRAINT ck_product_types_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_product_types_schema_version CHECK (schema_version >= 1), CONSTRAINT ck_product_types_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.product_type_characteristics (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo_producto_id uuid NOT NULL, caracteristica_id uuid NOT NULL,
      obligatoria boolean NOT NULL DEFAULT false, estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fk_ptc_tipo_producto FOREIGN KEY (tipo_producto_id) REFERENCES taxonomy.product_types(id) ON DELETE RESTRICT,
      CONSTRAINT fk_ptc_caracteristica FOREIGN KEY (caracteristica_id) REFERENCES taxonomy.characteristics(id) ON DELETE RESTRICT,
      CONSTRAINT uq_ptc_tipo_caracteristica UNIQUE (tipo_producto_id, caracteristica_id)
    )`,
    `CREATE TABLE taxonomy.runtime_settings (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      clave text NOT NULL UNIQUE, valor_integer integer NOT NULL CHECK (valor_integer > 0),
      descripcion text NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    "INSERT INTO taxonomy.runtime_settings (clave, valor_integer) VALUES ('MASTER_DEACTIVATION_TIMEOUT_SECONDS', 60)",
    `CREATE TABLE taxonomy.categories (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      nombre text NOT NULL,
      descripcion text NULL,
      categoria_padre_id uuid NULL,
      nivel smallint NOT NULL DEFAULT 1,
      orden integer NOT NULL DEFAULT 0,
      imagen_url text NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_categories PRIMARY KEY (id),
      CONSTRAINT fk_categories_categoria_padre FOREIGN KEY (categoria_padre_id)
        REFERENCES taxonomy.categories(id) ON DELETE RESTRICT,
      CONSTRAINT ck_categories_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_categories_nivel CHECK (nivel IN (1, 2)),
      CONSTRAINT ck_categories_orden CHECK (orden >= 0),
      CONSTRAINT ck_categories_version CHECK (taxonomy_version >= 0),
      CONSTRAINT ck_categories_no_self_parent CHECK (categoria_padre_id <> id),
      CONSTRAINT ck_categories_padre_nivel CHECK (
        (categoria_padre_id IS NULL AND nivel = 1) OR
        (categoria_padre_id IS NOT NULL AND nivel = 2)
      )
    )`,
    `CREATE TABLE taxonomy.category_seo (
      id uuid NOT NULL DEFAULT gen_random_uuid(), categoria_id uuid NOT NULL,
      slug text NOT NULL, meta_titulo text NULL, meta_descripcion text NULL,
      taxonomy_version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_category_seo PRIMARY KEY (id),
      CONSTRAINT fk_category_seo_categoria FOREIGN KEY (categoria_id) REFERENCES taxonomy.categories(id) ON DELETE RESTRICT,
      CONSTRAINT uq_category_seo_categoria UNIQUE (categoria_id), CONSTRAINT uq_category_seo_slug UNIQUE (slug),
      CONSTRAINT ck_category_seo_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      CONSTRAINT ck_category_seo_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.slug_history (
      id uuid NOT NULL DEFAULT gen_random_uuid(), categoria_id uuid NOT NULL,
      old_slug text NOT NULL, new_slug text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_slug_history PRIMARY KEY (id),
      CONSTRAINT fk_slug_history_categoria FOREIGN KEY (categoria_id) REFERENCES taxonomy.categories(id) ON DELETE RESTRICT,
      CONSTRAINT uq_slug_history_old_slug UNIQUE (old_slug)
    )`,
    `CREATE OR REPLACE FUNCTION taxonomy.fn_track_slug_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.slug <> NEW.slug THEN
        INSERT INTO taxonomy.slug_history(categoria_id,old_slug,new_slug,changed_at) VALUES (NEW.categoria_id,OLD.slug,NEW.slug,statement_timestamp());
      END IF; RETURN NEW; END $$`,
    `CREATE TRIGGER trg_category_seo_track_slug AFTER UPDATE OF slug ON taxonomy.category_seo
      FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_track_slug_history()`,
    `CREATE TABLE taxonomy.brands (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      nombre text NOT NULL,
      nombre_normalizado text GENERATED ALWAYS AS (lower(regexp_replace(btrim(nombre), '[[:space:]]+', ' ', 'g'))) STORED,
      descripcion text NULL,
      logo_url text NULL,
      pais_origen_iso char(2) NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_brands PRIMARY KEY (id),
      CONSTRAINT uq_brands_nombre_normalizado UNIQUE (nombre_normalizado),
      CONSTRAINT ck_brands_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_brands_nombre_normalizado_not_empty CHECK (length(trim(nombre_normalizado)) > 0),
      CONSTRAINT ck_brands_pais_iso CHECK (pais_origen_iso IS NULL OR pais_origen_iso ~ '^[A-Z]{2}$'),
      CONSTRAINT ck_brands_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.master_deactivation_operations (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      operation_id uuid NOT NULL,
      entity_type taxonomy.tipo_entidad_maestra NOT NULL,
      entity_id uuid NOT NULL,
      status taxonomy.estado_operacion_baja NOT NULL DEFAULT 'REQUESTED',
      reason text NULL,
      correlation_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_master_deactivation_operations PRIMARY KEY (id),
      CONSTRAINT uq_mdo_operation_id UNIQUE (operation_id),
      CONSTRAINT ck_mdo_operation_id_not_nil CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
      CONSTRAINT ck_mdo_correlation_id_not_nil CHECK (correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    )`,
    `CREATE TABLE taxonomy.outbox (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      message_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      event_name text NOT NULL, kind text NOT NULL, schema_version integer NOT NULL DEFAULT 1,
      correlation_id uuid NOT NULL, causation_id uuid NULL, operation_id uuid NULL,
      occurred_at timestamptz NOT NULL, payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz NULL,
      attempts integer NOT NULL DEFAULT 0, last_error text NULL
    )`,
    `CREATE TABLE taxonomy.inbox (
      id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      message_id uuid NOT NULL, handler text NOT NULL, event_name text NOT NULL,
      correlation_id uuid NULL, payload jsonb NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(), result text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_inbox_message_handler UNIQUE (message_id, handler),
      CONSTRAINT ck_inbox_handler_not_empty CHECK (length(trim(handler)) > 0),
      CONSTRAINT ck_inbox_result CHECK (result IN ('PROCESSED', 'IGNORED', 'FAILED'))
    )`,
    'CREATE INDEX ix_categories_padre_id ON taxonomy.categories(categoria_padre_id)',
    'CREATE INDEX ix_mdo_entity ON taxonomy.master_deactivation_operations(entity_type, entity_id)',
    'REVOKE ALL ON SCHEMA taxonomy FROM PUBLIC',
    "INSERT INTO taxonomy.runtime_settings (clave, valor_integer) VALUES ('MAX_PRODUCT_TYPE_ATTRIBUTES', 20)",
    "INSERT INTO taxonomy.runtime_settings (clave, valor_integer) VALUES ('MAX_ACTIVE_LIST_VALUES', 50)",
    `CREATE OR REPLACE FUNCTION taxonomy.fn_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;`,
    `CREATE OR REPLACE FUNCTION taxonomy.fn_prevent_characteristic_type_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.tipo <> NEW.tipo THEN
        RAISE EXCEPTION 'El tipo de característica (%) es inmutable y no puede modificarse a %',
            OLD.tipo, NEW.tipo;
    END IF;
    RETURN NEW;
END;
$$;`,
    `CREATE OR REPLACE FUNCTION taxonomy.fn_enforce_characteristic_value_rules()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_tipo taxonomy.tipo_caracteristica;
    v_activos integer;
    v_limite integer;
BEGIN
    SELECT tipo INTO v_tipo
    FROM taxonomy.characteristics
    WHERE id = NEW.caracteristica_id
    FOR UPDATE;
    IF v_tipo <> 'LISTA' THEN
        RAISE EXCEPTION 'Solo las características de tipo LISTA pueden tener valores predefinidos. Tipo actual: %', v_tipo;
    END IF;

    IF NEW.estado = 'ACTIVO' THEN
        SELECT valor_integer INTO v_limite FROM taxonomy.runtime_settings
        WHERE clave = 'MAX_ACTIVE_LIST_VALUES' FOR UPDATE;
        IF v_limite IS NULL OR v_limite < 1 THEN
            RAISE EXCEPTION 'Configuración MAX_ACTIVE_LIST_VALUES inválida';
        END IF;
        SELECT count(*) INTO v_activos
        FROM taxonomy.characteristic_values
        WHERE caracteristica_id = NEW.caracteristica_id
          AND estado = 'ACTIVO'
          AND id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
        IF v_activos >= v_limite THEN
            RAISE EXCEPTION 'Límite alcanzado: máximo % valores activos', v_limite;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;`,
    `CREATE OR REPLACE FUNCTION taxonomy.fn_bump_product_type_schema_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_tipo_producto_id uuid;
BEGIN
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
$$;`,
    `CREATE OR REPLACE FUNCTION taxonomy.fn_enforce_product_type_attribute_limit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_limit integer;
    v_active integer;
BEGIN
    IF NEW.estado <> 'ACTIVO' THEN
        RETURN NEW;
    END IF;

    SELECT valor_integer INTO v_limit
    FROM taxonomy.runtime_settings
    WHERE clave = 'MAX_PRODUCT_TYPE_ATTRIBUTES'
    FOR UPDATE;

    IF v_limit IS NULL OR v_limit < 1 THEN
        RAISE EXCEPTION 'Configuracion MAX_PRODUCT_TYPE_ATTRIBUTES invalida';
    END IF;

    SELECT count(*) INTO v_active
    FROM taxonomy.product_type_characteristics
    WHERE tipo_producto_id = NEW.tipo_producto_id
      AND estado = 'ACTIVO'
      AND id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

    IF v_active >= v_limit THEN
        RAISE EXCEPTION 'Limite alcanzado: un tipo de producto no puede tener mas de % caracteristicas activas', v_limit;
    END IF;

    RETURN NEW;
END;
$$;`,
    `CREATE TRIGGER trg_characteristics_updated_at
    BEFORE UPDATE ON taxonomy.characteristics
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_set_updated_at();`,
    `CREATE TRIGGER trg_characteristics_prevent_type_change
    BEFORE UPDATE OF tipo ON taxonomy.characteristics
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_prevent_characteristic_type_change();`,
    `CREATE TRIGGER trg_characteristic_values_updated_at
    BEFORE UPDATE ON taxonomy.characteristic_values
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_set_updated_at();`,
    `CREATE TRIGGER trg_characteristic_values_rules
    BEFORE INSERT OR UPDATE ON taxonomy.characteristic_values
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_enforce_characteristic_value_rules();`,
    `CREATE TRIGGER trg_product_types_updated_at
    BEFORE UPDATE ON taxonomy.product_types
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_set_updated_at();`,
    `CREATE TRIGGER trg_ptc_updated_at
    BEFORE UPDATE ON taxonomy.product_type_characteristics
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_set_updated_at();`,
    `CREATE TRIGGER trg_ptc_attribute_limit
    BEFORE INSERT OR UPDATE OF tipo_producto_id, caracteristica_id, estado ON taxonomy.product_type_characteristics
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_enforce_product_type_attribute_limit();`,
    `CREATE TRIGGER trg_ptc_bump_schema_version
    AFTER INSERT OR UPDATE OF obligatoria, estado OR DELETE ON taxonomy.product_type_characteristics
    FOR EACH ROW EXECUTE FUNCTION taxonomy.fn_bump_product_type_schema_version();`,
    `GRANT USAGE ON SCHEMA taxonomy TO ${ROL_APP}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA taxonomy TO ${ROL_APP}`,
  ];
}

export function construirSentenciasSemilla(): string[] {
  return [
    `INSERT INTO taxonomy.categories (id, nombre, nivel, orden, estado) VALUES
      ('11111111-1111-4111-8111-111111111111', 'Calzado', 1, 0, 'ACTIVO')`,
    `INSERT INTO taxonomy.categories (id, nombre, categoria_padre_id, nivel, orden, estado) VALUES
      ('22222222-2222-4222-8222-222222222222', 'Zapatillas', '11111111-1111-4111-8111-111111111111', 2, 0, 'ACTIVO')`,
    `INSERT INTO taxonomy.categories (id, nombre, nivel, orden, estado) VALUES
      ('33333333-3333-4333-8333-333333333333', 'Descontinuada', 1, 0, 'INACTIVO')`,
    `INSERT INTO taxonomy.brands (id, nombre, descripcion, pais_origen_iso, estado) VALUES
      ('44444444-4444-4444-8444-444444444444', 'Marathon', 'Marca ecuatoriana', 'EC', 'ACTIVO')`,
    `INSERT INTO taxonomy.brands (id, nombre, descripcion, pais_origen_iso, estado) VALUES
      ('55555555-5555-4555-8555-555555555555', 'Retirada', NULL, NULL, 'INACTIVO')`,
  ];
}
