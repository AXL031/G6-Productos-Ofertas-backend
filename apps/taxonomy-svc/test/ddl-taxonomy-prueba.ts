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
    'CREATE INDEX ix_categories_padre_id ON taxonomy.categories(categoria_padre_id)',
    'CREATE INDEX ix_mdo_entity ON taxonomy.master_deactivation_operations(entity_type, entity_id)',
    'REVOKE ALL ON SCHEMA taxonomy FROM PUBLIC',
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
