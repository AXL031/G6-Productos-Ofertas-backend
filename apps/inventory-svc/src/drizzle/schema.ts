import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
  unique,
} from 'drizzle-orm/pg-core';

export const inventorySchema = pgSchema('inventory');

export const reservationStatusEnum = inventorySchema.enum(
  'reservation_status',
  ['ACTIVA', 'CONSUMIDA', 'LIBERADA', 'EXPIRADA'],
);

export const operationTypeEnum = inventorySchema.enum('operation_type', [
  'RESERVA',
  'CONSUMO',
  'LIBERACION',
  'EXPIRACION',
  'AJUSTE_ABSOLUTO',
  'INCIDENCIA_BLOQUEO',
  'INCIDENCIA_RESOLUCION',
  'REINTEGRO',
  'CONCILIACION_OFFLINE',
  'RECEPCION_TRASLADO',
  'INICIALIZACION_SKU',
]);

export const operationStatusEnum = inventorySchema.enum('operation_status', [
  'RECIBIDO',
  'APLICADO',
  'RECHAZADO',
  'REQUIRES_REVIEW',
]);

export const stockStatusEnum = inventorySchema.enum('stock_status', [
  'AGOTADO',
  'STOCK_BAJO',
  'DISPONIBLE',
]);

export const outboxStatusEnum = inventorySchema.enum('outbox_status', [
  'PENDING',
  'PUBLISHED',
]);

export const inboxStatusEnum = inventorySchema.enum('inbox_status', [
  'RECEIVED',
  'PROCESSED',
]);

export const incidenciaEstadoEnum = inventorySchema.enum('incidencia_estado', [
  'ABIERTA',
  'RESUELTA',
  'TRASLADO_PENDIENTE',
]);

export const tipoResolucionIncidenciaEnum = inventorySchema.enum(
  'tipo_resolucion_incidencia',
  ['REHABILITADO', 'MERMA', 'FALTANTE_CONFIRMADO', 'TRASLADO_ALMACEN_CENTRAL'],
);

export const trasladoEstadoEnum = inventorySchema.enum('traslado_estado', [
  'EN_TRANSITO',
  'RECIBIDO_PARCIAL',
  'COMPLETADO',
  'COMPLETADO_CON_DISCREPANCIA',
]);

export const disposicionRecepcionTrasladoEnum = inventorySchema.enum(
  'disposicion_recepcion_traslado',
  ['REINGRESAR_DISPONIBLE', 'REINGRESAR_BLOQUEADO', 'CONFIRMAR_MERMA'],
);

// 1. locations
export const locations = inventorySchema.table('locations', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  external_ref: text('external_ref'),
  active: boolean('active').default(true).notNull(),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 2. stock_balance
export const stockBalance = inventorySchema.table(
  'stock_balance',
  {
    sku_id: text('sku_id').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    on_hand: integer('on_hand').default(0).notNull(),
    reserved: integer('reserved').default(0).notNull(),
    blocked: integer('blocked').default(0).notNull(),
    stock_version: bigint('stock_version', { mode: 'number' })
      .default(0)
      .notNull(),
    available: integer('available').generatedAlwaysAs(
      sql`GREATEST(0, on_hand - reserved - blocked)`,
    ),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sku_id, t.location_id] }),
    check(
      'ck_sb_no_negativo',
      sql`${t.on_hand} >= 0 AND ${t.reserved} >= 0 AND ${t.blocked} >= 0`,
    ),
    check(
      'ck_sb_reserved_plus_blocked',
      sql`${t.reserved} + ${t.blocked} <= ${t.on_hand}`,
    ),
    index('ix_stock_balance_location_id').on(t.location_id),
  ],
);

// 3. reservations
export const reservations = inventorySchema.table(
  'reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reservation_id: uuid('reservation_id').notNull().unique(),
    status: reservationStatusEnum('status').default('ACTIVA').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    idempotency_key: text('idempotency_key').notNull().unique(),
    intention: text('intention').default('reservar').notNull(),
    correlation_id: uuid('correlation_id'),
    order_id: text('order_id'),
    operation_id: uuid('operation_id'),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    released_at: timestamp('released_at', { withTimezone: true }),
    expired_at: timestamp('expired_at', { withTimezone: true }),
    request_fingerprint: text('request_fingerprint'),
    accepted_payload: jsonb('accepted_payload'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('uq_inventory_reservations_operation_id')
      .on(t.operation_id)
      .where(sql`${t.operation_id} IS NOT NULL`),
    check(
      'ck_reservations_order_id_nonblank',
      sql`${t.order_id} IS NULL OR length(btrim(${t.order_id})) > 0`,
    ),
    check(
      'ck_inventory_reservations_fingerprint',
      sql`${t.request_fingerprint} IS NULL OR ${t.request_fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ck_inventory_reservations_accepted_payload',
      sql`${t.accepted_payload} IS NULL OR jsonb_typeof(${t.accepted_payload}) = 'object'`,
    ),
    index('ix_reservations_ttl')
      .on(t.status, t.expires_at)
      .where(sql`${t.status} = 'ACTIVA'`),
    index('ix_inventory_reservations_order_id').on(t.order_id),
  ],
);

// 4. reservation_lines
export const reservationLines = inventorySchema.table(
  'reservation_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reservation_id: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    sku_id: text('sku_id').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    unique('uq_reservation_lines').on(
      t.reservation_id,
      t.sku_id,
      t.location_id,
    ),
    check('reservation_lines_quantity_check', sql`${t.quantity} > 0`),
    index('ix_reservation_lines_reservation_id').on(t.reservation_id),
    index('ix_reservation_lines_location_id').on(t.location_id),
    index('ix_reservation_lines_sku').on(t.sku_id, t.location_id),
  ],
);

// 5. inventory_operations
export const inventoryOperations = inventorySchema.table(
  'inventory_operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    operation_type: operationTypeEnum('operation_type').notNull(),
    idempotency_key: text('idempotency_key').notNull().unique(),
    intention: text('intention').notNull(),
    status: operationStatusEnum('status').default('RECIBIDO').notNull(),
    sku_id: text('sku_id'),
    location_id: uuid('location_id').references(() => locations.id, {
      onDelete: 'restrict',
    }),
    quantity_requested: integer('quantity_requested'),
    quantity_applied: integer('quantity_applied'),
    result_code: text('result_code'),
    correlation_id: uuid('correlation_id'),
    order_id: text('order_id'),
    reservation_id: uuid('reservation_id'),
    stock_version: bigint('stock_version', { mode: 'number' }),
    accepted_at: timestamp('accepted_at', { withTimezone: true }),
    applied_at: timestamp('applied_at', { withTimezone: true }),
    operation_id: uuid('operation_id'),
    client_id: text('client_id'),
    request_fingerprint: text('request_fingerprint'),
    request_payload: jsonb('request_payload'),
    result_payload: jsonb('result_payload'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('uq_inventory_operations_operation_id')
      .on(t.operation_id)
      .where(sql`${t.operation_id} IS NOT NULL`),
    check(
      'chk_op_qty',
      sql`(${t.quantity_requested} IS NULL OR ${t.quantity_requested} >= 0) AND (${t.quantity_applied} IS NULL OR ${t.quantity_applied} >= 0)`,
    ),
    check(
      'ck_inventory_operations_order_id_nonblank',
      sql`${t.order_id} IS NULL OR length(btrim(${t.order_id})) > 0`,
    ),
    check(
      'ck_inventory_operation_client_id',
      sql`${t.client_id} IS NULL OR length(btrim(${t.client_id})) > 0`,
    ),
    check(
      'ck_inventory_operation_request_fingerprint',
      sql`${t.request_fingerprint} IS NULL OR ${t.request_fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ck_inventory_operation_request_payload',
      sql`${t.request_payload} IS NULL OR jsonb_typeof(${t.request_payload}) = 'object'`,
    ),
    check(
      'ck_inventory_operation_result_payload',
      sql`${t.result_payload} IS NULL OR jsonb_typeof(${t.result_payload}) = 'object'`,
    ),
    index('ix_inventory_operations_location_id').on(t.location_id),
    index('ix_operations_sku').on(t.sku_id, t.location_id),
    index('ix_operations_type_status').on(t.operation_type, t.status),
    index('ix_inventory_operations_order_id').on(t.order_id),
  ],
);

// 6. kardex
export const kardex = inventorySchema.table(
  'kardex',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sku_id: text('sku_id').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    operation_type: operationTypeEnum('operation_type').notNull(),
    operation_id: uuid('operation_id'),
    reservation_id: uuid('reservation_id'),
    quantity: integer('quantity').notNull(),
    on_hand_before: integer('on_hand_before').notNull(),
    on_hand_after: integer('on_hand_after').notNull(),
    reserved_before: integer('reserved_before').notNull(),
    reserved_after: integer('reserved_after').notNull(),
    blocked_before: integer('blocked_before').notNull(),
    blocked_after: integer('blocked_after').notNull(),
    stock_version: bigint('stock_version', { mode: 'number' }).notNull(),
    correlation_id: uuid('correlation_id'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check('kardex_quantity_check', sql`${t.quantity} <> 0`),
    index('ix_kardex_location_id').on(t.location_id),
    index('ix_kardex_saldo').on(t.sku_id, t.location_id, t.created_at.desc()),
    index('ix_kardex_operation').on(t.operation_id),
  ],
);

// 7. outbox
export const outbox = inventorySchema.table(
  'outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    event_id: uuid('event_id').notNull().unique(),
    event_type: text('event_type').notNull(),
    aggregate_type: text('aggregate_type').notNull(),
    aggregate_id: text('aggregate_id').notNull(),
    correlation_id: uuid('correlation_id'),
    payload: jsonb('payload').notNull(),
    status: outboxStatusEnum('status').default('PENDING').notNull(),
    published_at: timestamp('published_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('ix_outbox_dispatcher').on(t.status, t.created_at)],
);

// 8. commercial_fulfillment_routes
export const commercialFulfillmentRoutes = inventorySchema.table(
  'commercial_fulfillment_routes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    channel_id: text('channel_id').notNull(),
    mode: text('mode').notNull(),
    fulfillment_ref: text('fulfillment_ref').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    active: boolean('active').default(true).notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      'commercial_fulfillment_routes_channel_id_check',
      sql`${t.channel_id} IN ('MARKETPLACE', 'CHATBOT', 'RETAIL')`,
    ),
    check(
      'commercial_fulfillment_routes_mode_check',
      sql`${t.mode} IN ('ENVIO_DOMICILIO', 'RETIRO_TIENDA', 'VENTA_TIENDA')`,
    ),
    check(
      'commercial_fulfillment_routes_fulfillment_ref_check',
      sql`length(btrim(${t.fulfillment_ref})) > 0`,
    ),
    uniqueIndex('uq_commercial_fulfillment_routes_active')
      .on(t.channel_id, t.mode, t.fulfillment_ref)
      .where(sql`${t.active}`),
    index('ix_commercial_fulfillment_routes_location')
      .on(t.location_id)
      .where(sql`${t.active}`),
  ],
);

// 9. stock_threshold_override
export const stockThresholdOverride = inventorySchema.table(
  'stock_threshold_override',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sku_id: text('sku_id'),
    location_id: uuid('location_id').references(() => locations.id, {
      onDelete: 'restrict',
    }),
    umbral_efectivo: integer('umbral_efectivo').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      'stock_threshold_override_umbral_efectivo_check',
      sql`${t.umbral_efectivo} >= 0`,
    ),
    check(
      'chk_threshold_scope',
      sql`${t.location_id} IS NULL AND (${t.sku_id} IS NULL OR ${t.sku_id} IS NOT NULL)`,
    ),
    unique('uq_threshold_override').on(t.sku_id, t.location_id),
    uniqueIndex('ix_threshold_global')
      .on(sql`(1)`)
      .where(sql`${t.sku_id} IS NULL AND ${t.location_id} IS NULL`),
  ],
);

// 10. incidencias
export const incidencias = inventorySchema.table(
  'incidencias',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    incidencia_id: uuid('incidencia_id').notNull().unique(),
    sku_id: text('sku_id').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    external_incident_id: text('external_incident_id'),
    act_ref: text('act_ref'),
    estado: incidenciaEstadoEnum('estado').default('ABIERTA').notNull(),
    tipo_resolucion: tipoResolucionIncidenciaEnum('tipo_resolucion'),
    cantidad_bloqueada: integer('cantidad_bloqueada').notNull(),
    idempotency_key: text('idempotency_key').notNull().unique(),
    correlation_id: uuid('correlation_id'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'incidencias_cantidad_bloqueada_check',
      sql`${t.cantidad_bloqueada} > 0`,
    ),
    index('ix_incidencias_location_id').on(t.location_id),
    index('ix_incidencias_estado').on(t.estado),
    index('ix_incidencias_sku').on(t.sku_id, t.location_id),
  ],
);

// 11. traslados
export const traslados = inventorySchema.table(
  'traslados',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traslado_id: uuid('traslado_id').notNull().unique(),
    source_incident_id: uuid('source_incident_id'),
    sku_id: text('sku_id').notNull(),
    source_location_id: uuid('source_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    target_location_id: uuid('target_location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    quantity_shipped: integer('quantity_shipped').notNull(),
    quantity_received: integer('quantity_received').default(0).notNull(),
    missing_quantity: integer('missing_quantity'),
    estado: trasladoEstadoEnum('estado').default('EN_TRANSITO').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('ix_traslado_por_incidencia')
      .on(t.source_incident_id)
      .where(sql`${t.source_incident_id} IS NOT NULL`),
    check('traslados_quantity_shipped_check', sql`${t.quantity_shipped} > 0`),
    check(
      'traslados_quantity_received_check',
      sql`${t.quantity_received} >= 0`,
    ),
    check(
      'chk_traslado_missing',
      sql`${t.missing_quantity} IS NULL OR ${t.missing_quantity} >= 0`,
    ),
    index('ix_traslados_source_location_id').on(t.source_location_id),
    index('ix_traslados_target_location_id').on(t.target_location_id),
    index('ix_traslados_estado').on(t.estado),
    index('ix_traslados_source').on(t.source_location_id, t.estado),
  ],
);

// 12. traslado_recepciones
export const trasladoRecepciones = inventorySchema.table(
  'traslado_recepciones',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recepcion_id: uuid('recepcion_id').notNull().unique(),
    traslado_id: uuid('traslado_id')
      .notNull()
      .references(() => traslados.id, { onDelete: 'cascade' }),
    cantidad_recibida: integer('cantidad_recibida').notNull(),
    disposicion: disposicionRecepcionTrasladoEnum('disposicion').notNull(),
    es_recepcion_final: boolean('es_recepcion_final').default(false).notNull(),
    sub_gestor: text('sub_gestor').notNull(),
    idempotency_key: text('idempotency_key').notNull().unique(),
    received_at: timestamp('received_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      'traslado_recepciones_cantidad_recibida_check',
      sql`${t.cantidad_recibida} > 0`,
    ),
    index('ix_recepciones_traslado').on(t.traslado_id),
  ],
);

// 13. inventory_config
export const inventoryConfig = inventorySchema.table('inventory_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 14. dashboard_projection
export const dashboardProjection = inventorySchema.table(
  'dashboard_projection',
  {
    sku_id: text('sku_id').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    on_hand: integer('on_hand').notNull(),
    reserved: integer('reserved').notNull(),
    blocked: integer('blocked').notNull(),
    available: integer('available').generatedAlwaysAs(
      sql`GREATEST(0, on_hand - reserved - blocked)`,
    ),
    status: stockStatusEnum('status').notNull(),
    umbral_efectivo: integer('umbral_efectivo').notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sku_id, t.location_id] }),
    check(
      'chk_dp_no_negativo',
      sql`${t.on_hand} >= 0 AND ${t.reserved} >= 0 AND ${t.blocked} >= 0`,
    ),
    check(
      'chk_dp_reserved_plus_blocked',
      sql`${t.reserved} + ${t.blocked} <= ${t.on_hand}`,
    ),
    index('ix_dashboard_projection_location_id').on(t.location_id),
    index('ix_dashboard_ubicacion_estado').on(t.location_id, t.status),
    index('ix_dashboard_estado').on(t.status),
  ],
);

// 15. inbox
export const inbox = inventorySchema.table(
  'inbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    message_id: uuid('message_id').notNull().unique(),
    message_type: text('message_type').notNull(),
    source: text('source').notNull(),
    payload: jsonb('payload').notNull(),
    status: inboxStatusEnum('status').default('RECEIVED').notNull(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('ix_inbox_processing').on(t.status, t.created_at)],
);
