import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const taxonomia = pgSchema('taxonomy');

export const estadoEntidad = taxonomia.enum('estado_entidad', [
  'ACTIVO',
  'INACTIVO',
  'PENDING_DEACTIVATION',
]);

// El enum físico histórico contiene CHARACTERISTIC, aunque DEC-G6-INT-05
// no lo admite en el protocolo de baja segura.
export const tipoEntidadMaestra = taxonomia.enum('tipo_entidad_maestra', [
  'CATEGORY',
  'BRAND',
  'CHARACTERISTIC',
  'CHARACTERISTIC_VALUE',
  'PRODUCT_TYPE',
  'PRODUCT_TYPE_CHARACTERISTIC',
]);

export const estadoOperacionBaja = taxonomia.enum('estado_operacion_baja', [
  'REQUESTED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'FAILED',
]);

export const categorias = taxonomia.table(
  'categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nombre: text('nombre').notNull(),
    descripcion: text('descripcion'),
    categoriaPadreId: uuid('categoria_padre_id'),
    nivel: smallint('nivel').notNull().default(1),
    orden: integer('orden').notNull().default(0),
    imagenUrl: text('imagen_url'),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    foreignKey({
      columns: [tabla.categoriaPadreId],
      foreignColumns: [tabla.id],
      name: 'fk_categories_categoria_padre',
    }).onDelete('restrict'),
    check(
      'ck_categories_nombre_not_empty',
      sql`length(trim(${tabla.nombre})) > 0`,
    ),
    check('ck_categories_nivel', sql`${tabla.nivel} IN (1, 2)`),
    check('ck_categories_orden', sql`${tabla.orden} >= 0`),
    check('ck_categories_version', sql`${tabla.taxonomyVersion} >= 0`),
    check(
      'ck_categories_no_self_parent',
      sql`${tabla.categoriaPadreId} <> ${tabla.id}`,
    ),
    check(
      'ck_categories_padre_nivel',
      sql`(${tabla.categoriaPadreId} IS NULL AND ${tabla.nivel} = 1) OR (${tabla.categoriaPadreId} IS NOT NULL AND ${tabla.nivel} = 2)`,
    ),
    index('ix_categories_padre_id').on(tabla.categoriaPadreId),
  ],
);

export const marcas = taxonomia.table(
  'brands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nombre: text('nombre').notNull(),
    nombreNormalizado: text('nombre_normalizado').generatedAlwaysAs(
      sql`lower(regexp_replace(btrim(nombre), '[[:space:]]+', ' ', 'g'))`,
    ),
    descripcion: text('descripcion'),
    logoUrl: text('logo_url'),
    paisOrigenIso: char('pais_origen_iso', { length: 2 }),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    unique('uq_brands_nombre_normalizado').on(tabla.nombreNormalizado),
    check('ck_brands_nombre_not_empty', sql`length(trim(${tabla.nombre})) > 0`),
    check(
      'ck_brands_nombre_normalizado_not_empty',
      sql`length(trim(${tabla.nombreNormalizado})) > 0`,
    ),
    check(
      'ck_brands_pais_iso',
      sql`${tabla.paisOrigenIso} IS NULL OR ${tabla.paisOrigenIso} ~ '^[A-Z]{2}$'`,
    ),
    check('ck_brands_version', sql`${tabla.taxonomyVersion} >= 0`),
  ],
);

// Mapea únicamente columnas presentes en la migración histórica oficial.
export const operacionesBaja = taxonomia.table(
  'master_deactivation_operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    operationId: uuid('operation_id').notNull(),
    entityType: tipoEntidadMaestra('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    status: estadoOperacionBaja('status').notNull().default('REQUESTED'),
    reason: text('reason'),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    unique('uq_mdo_operation_id').on(tabla.operationId),
    check(
      'ck_mdo_operation_id_not_nil',
      sql`${tabla.operationId} <> '00000000-0000-0000-0000-000000000000'::uuid`,
    ),
    check(
      'ck_mdo_correlation_id_not_nil',
      sql`${tabla.correlationId} <> '00000000-0000-0000-0000-000000000000'::uuid`,
    ),
    index('ix_mdo_entity').on(tabla.entityType, tabla.entityId),
  ],
);

export const esquemaTaxonomia = {
  estadoEntidad,
  categorias,
  marcas,
  tipoEntidadMaestra,
  estadoOperacionBaja,
  operacionesBaja,
};
