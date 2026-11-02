import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const catalog = pgSchema('catalog');

export const estadoProducto = catalog.enum('estado_producto', [
  'BORRADOR',
  'ACTIVO',
  'INACTIVO',
]);
export const estadoVariante = catalog.enum('estado_variante', [
  'BORRADOR',
  'ACTIVA',
  'INACTIVA',
]);

const id = () => uuid('id').defaultRandom().notNull();
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull();

export const products = catalog.table(
  'products',
  {
    id: id(),
    nombre: text('nombre').notNull(),
    descripcion: text('descripcion').notNull(),
    categoria_id: text('categoria_id').notNull(),
    tipo_producto_id: text('tipo_producto_id').notNull(),
    marca_id: text('marca_id').notNull(),
    sku_base: text('sku_base').notNull(),
    slug: text('slug').notNull(),
    tiene_variantes: boolean('tiene_variantes').notNull(),
    estado: estadoProducto('estado').default('BORRADOR').notNull(),
    publicado_alguna_vez: boolean('publicado_alguna_vez').default(false),
    catalog_version: bigint('catalog_version', { mode: 'bigint' })
      .default(0n)
      .notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_products', columns: [table.id] }),
    unique('uq_products_sku_base').on(table.sku_base),
    unique('uq_products_slug').on(table.slug),
    check(
      'ck_products_minimos',
      sql`length(${table.nombre}) > 0 AND length(${table.descripcion}) > 0 AND length(${table.categoria_id}) > 0 AND length(${table.tipo_producto_id}) > 0 AND length(${table.marca_id}) > 0 AND length(${table.sku_base}) > 0 AND length(${table.slug}) > 0`,
    ),
    check('ck_products_version', sql`${table.catalog_version} >= 0`),
    index('ix_products_estado_created_at').on(
      table.estado,
      table.created_at,
      table.id,
    ),
    index('ix_products_categoria_id').on(table.categoria_id),
    index('ix_products_marca_id').on(table.marca_id),
    index('ix_products_tipo_producto_id').on(table.tipo_producto_id),
  ],
);

export const variants = catalog.table(
  'variants',
  {
    id: id(),
    product_id: uuid('product_id').notNull(),
    sku: text('sku').notNull(),
    identifying_key: jsonb('identifying_key')
      .$type<Record<string, unknown>>()
      .notNull(),
    estado: estadoVariante('estado').default('BORRADOR').notNull(),
    catalog_version: bigint('catalog_version', { mode: 'bigint' })
      .default(0n)
      .notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_variants', columns: [table.id] }),
    foreignKey({
      name: 'fk_variants_product_id',
      columns: [table.product_id],
      foreignColumns: [products.id],
    }).onDelete('cascade'),
    unique('uq_variants_sku').on(table.sku),
    unique('uq_variants_product_combination').on(
      table.product_id,
      table.identifying_key,
    ),
    unique('uq_variants_id_product').on(table.id, table.product_id),
    check('ck_variants_sku', sql`length(${table.sku}) > 0`),
    check(
      'ck_variants_identifying_key',
      sql`jsonb_typeof(${table.identifying_key}) = 'object' AND ${table.identifying_key} <> '{}'::jsonb`,
    ),
    check('ck_variants_version', sql`${table.catalog_version} >= 0`),
    index('ix_variants_product_id').on(table.product_id, table.estado),
  ],
);

export const skuIdentity = catalog.table(
  'sku_identity',
  {
    id: id(),
    sku: text('sku').notNull(),
    product_id: uuid('product_id'),
    variant_id: uuid('variant_id'),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_sku_identity', columns: [table.id] }),
    foreignKey({
      name: 'fk_sku_identity_product_id',
      columns: [table.product_id],
      foreignColumns: [products.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_sku_identity_variant_id',
      columns: [table.variant_id],
      foreignColumns: [variants.id],
    }).onDelete('restrict'),
    unique('uq_sku_identity_sku').on(table.sku),
    unique('uq_sku_identity_product').on(table.product_id),
    unique('uq_sku_identity_variant').on(table.variant_id),
    check(
      'ck_sku_identity_owner',
      sql`num_nonnulls(${table.product_id}, ${table.variant_id}) = 1`,
    ),
  ],
);

export const productImages = catalog.table(
  'product_images',
  {
    id: id(),
    product_id: uuid('product_id').notNull(),
    url: text('url').notNull(),
    principal: boolean('principal').default(false).notNull(),
    posicion: integer('posicion').default(0).notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_product_images', columns: [table.id] }),
    foreignKey({
      name: 'fk_product_images_product_id',
      columns: [table.product_id],
      foreignColumns: [products.id],
    }).onDelete('cascade'),
    check('ck_product_images_url', sql`length(${table.url}) > 0`),
    check('ck_product_images_posicion', sql`${table.posicion} >= 0`),
    index('ix_product_images_product_id').on(table.product_id),
  ],
);

export const variantImages = catalog.table(
  'variant_images',
  {
    id: id(),
    variant_id: uuid('variant_id').notNull(),
    url: text('url').notNull(),
    posicion: integer('posicion').default(0).notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_variant_images', columns: [table.id] }),
    foreignKey({
      name: 'fk_variant_images_variant_id',
      columns: [table.variant_id],
      foreignColumns: [variants.id],
    }).onDelete('cascade'),
    check('ck_variant_images_url', sql`length(${table.url}) > 0`),
    check('ck_variant_images_posicion', sql`${table.posicion} >= 0`),
    index('ix_variant_images_variant_id').on(table.variant_id),
  ],
);

export const productAttributes = catalog.table(
  'product_attribute_values',
  {
    id: id(),
    product_id: uuid('product_id').notNull(),
    caracteristica_id: text('caracteristica_id').notNull(),
    nombre_snapshot: text('nombre_snapshot').notNull(),
    valor_id: text('valor_id'),
    valor: jsonb('valor').$type<unknown>().notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_product_attribute_values', columns: [table.id] }),
    foreignKey({
      name: 'fk_product_attribute_values_product_id',
      columns: [table.product_id],
      foreignColumns: [products.id],
    }).onDelete('cascade'),
    unique('uq_product_attribute_values_characteristic').on(
      table.product_id,
      table.caracteristica_id,
    ),
  ],
);

export const variantAttributes = catalog.table(
  'variant_attribute_values',
  {
    id: id(),
    variant_id: uuid('variant_id').notNull(),
    caracteristica_id: text('caracteristica_id').notNull(),
    nombre_snapshot: text('nombre_snapshot').notNull(),
    valor_id: text('valor_id'),
    valor: jsonb('valor').$type<unknown>().notNull(),
    es_identificador: boolean('es_identificador').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_variant_attribute_values', columns: [table.id] }),
    foreignKey({
      name: 'fk_variant_attribute_values_variant_id',
      columns: [table.variant_id],
      foreignColumns: [variants.id],
    }).onDelete('cascade'),
    unique('uq_variant_attribute_values_characteristic').on(
      table.variant_id,
      table.caracteristica_id,
    ),
  ],
);

export const productIdentifyingCharacteristics = catalog.table(
  'product_identifying_characteristics',
  {
    id: id(),
    product_id: uuid('product_id').notNull(),
    caracteristica_id: text('caracteristica_id').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'pk_product_identifying_characteristics',
      columns: [table.id],
    }),
    foreignKey({
      name: 'fk_product_identifying_characteristics_product_id',
      columns: [table.product_id],
      foreignColumns: [products.id],
    }).onDelete('cascade'),
    unique('uq_product_identifying_characteristics_ref').on(
      table.product_id,
      table.caracteristica_id,
    ),
  ],
);

export const skuPhysicalProfiles = catalog.table(
  'sku_physical_profiles',
  {
    id: id(),
    sku_identity_id: uuid('sku_identity_id').notNull(),
    peso_kg: numeric('peso_kg'),
    largo_cm: numeric('largo_cm'),
    ancho_cm: numeric('ancho_cm'),
    alto_cm: numeric('alto_cm'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_sku_physical_profiles', columns: [table.id] }),
    foreignKey({
      name: 'fk_sku_physical_profiles_sku_identity_id',
      columns: [table.sku_identity_id],
      foreignColumns: [skuIdentity.id],
    }).onDelete('restrict'),
    unique('uq_sku_physical_profiles_identity').on(table.sku_identity_id),
    check(
      'ck_sku_physical_profiles_positive',
      sql`(${table.peso_kg} IS NULL OR (${table.peso_kg} > 0 AND ${table.peso_kg} NOT IN ('NaN'::numeric, 'Infinity'::numeric))) AND (${table.largo_cm} IS NULL OR (${table.largo_cm} > 0 AND ${table.largo_cm} NOT IN ('NaN'::numeric, 'Infinity'::numeric))) AND (${table.ancho_cm} IS NULL OR (${table.ancho_cm} > 0 AND ${table.ancho_cm} NOT IN ('NaN'::numeric, 'Infinity'::numeric))) AND (${table.alto_cm} IS NULL OR (${table.alto_cm} > 0 AND ${table.alto_cm} NOT IN ('NaN'::numeric, 'Infinity'::numeric)))`,
    ),
  ],
);

export const activationChecks = catalog.table(
  'activation_checks',
  {
    id: id(),
    product_id: uuid('product_id').notNull(),
    variant_id: uuid('variant_id'),
    sku: text('sku').notNull(),
    dependency: text('dependency').notNull(),
    operation_id: uuid('operation_id').notNull(),
    correlation_id: uuid('correlation_id').notNull(),
    request_payload: jsonb('request_payload')
      .$type<Record<string, unknown>>()
      .notNull(),
    state: text('state').default('PENDING').notNull(),
    result_payload: jsonb('result_payload').$type<unknown>(),
    result_message_id: uuid('result_message_id'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_activation_checks', columns: [table.id] }),
    foreignKey({
      name: 'fk_activation_checks_product_id',
      columns: [table.product_id],
      foreignColumns: [products.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_activation_checks_variant_product',
      columns: [table.variant_id, table.product_id],
      foreignColumns: [variants.id, variants.product_id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_activation_checks_sku',
      columns: [table.sku],
      foreignColumns: [skuIdentity.sku],
    }).onDelete('restrict'),
    unique('uq_activation_checks_operation').on(table.operation_id),
    unique('uq_activation_checks_dependency_sku').on(
      table.dependency,
      table.sku,
    ),
    check(
      'ck_activation_checks_dependency',
      sql`${table.dependency} IN ('PRICING', 'INVENTORY')`,
    ),
    check(
      'ck_activation_checks_state',
      sql`${table.state} IN ('PENDING', 'COMPLETED', 'REJECTED')`,
    ),
    check(
      'ck_activation_checks_request',
      sql`jsonb_typeof(${table.request_payload}) = 'object'`,
    ),
    check(
      'ck_activation_checks_result',
      sql`${table.state} = 'PENDING' OR (${table.result_message_id} IS NOT NULL AND ${table.result_payload} IS NOT NULL)`,
    ),
    index('ix_activation_checks_product_id').on(table.product_id),
    index('ix_activation_checks_variant_product').on(
      table.variant_id,
      table.product_id,
    ),
    index('ix_activation_checks_sku').on(table.sku),
  ],
);

export const masterBarriers = catalog.table(
  'master_barriers',
  {
    id: id(),
    master_type: text('master_type').notNull(),
    master_id: text('master_id').notNull(),
    operation_id: uuid('operation_id').notNull(),
    is_blocking: boolean('is_blocking').default(true).notNull(),
    source_version: bigint('source_version', { mode: 'bigint' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_master_barriers', columns: [table.id] }),
    unique('uq_master_barriers_operation').on(table.operation_id),
    check(
      'ck_master_barriers_version',
      sql`${table.source_version} IS NULL OR ${table.source_version} >= 0`,
    ),
    index('ix_master_barriers_blocking')
      .on(table.master_type, table.master_id)
      .where(sql`${table.is_blocking}`),
  ],
);

export const outbox = catalog.table(
  'outbox',
  {
    id: id(),
    message_id: uuid('message_id').notNull(),
    event_name: text('event_name').notNull(),
    kind: text('kind').notNull(),
    schema_version: integer('schema_version').default(1).notNull(),
    correlation_id: uuid('correlation_id').notNull(),
    causation_id: uuid('causation_id'),
    operation_id: uuid('operation_id'),
    occurred_at: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    published_at: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    }),
    attempts: integer('attempts').default(0).notNull(),
    last_error: text('last_error'),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_outbox', columns: [table.id] }),
    unique('uq_outbox_message_id').on(table.message_id),
    check(
      'ck_outbox_kind',
      sql`${table.kind} IN ('command', 'event', 'result')`,
    ),
    check('ck_outbox_attempts', sql`${table.attempts} >= 0`),
    index('ix_outbox_pending')
      .on(table.occurred_at, table.id)
      .where(sql`${table.published_at} IS NULL`),
  ],
);

export const inbox = catalog.table(
  'inbox',
  {
    id: id(),
    message_id: uuid('message_id').notNull(),
    handler: text('handler').notNull(),
    event_name: text('event_name').notNull(),
    correlation_id: uuid('correlation_id'),
    operation_id: uuid('operation_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: text('result').notNull(),
    processed_at: timestamp('processed_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_inbox', columns: [table.id] }),
    unique('uq_inbox_message_handler').on(table.message_id, table.handler),
  ],
);

export const catalogSchema = {
  products,
  variants,
  skuIdentity,
  productImages,
  variantImages,
  productAttributes,
  variantAttributes,
  productIdentifyingCharacteristics,
  skuPhysicalProfiles,
  activationChecks,
  masterBarriers,
  outbox,
  inbox,
};
