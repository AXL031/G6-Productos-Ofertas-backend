// Runtime mapping of official migrations 0001–0004 at docs 51a5ce6e76bb0c61d93ef47416e46797bf5b9846.
// This file never provisions DDL. Deferred triggers/functions remain database-owned.
import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigint,
  primaryKey,
  foreignKey,
  unique,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const promotionsSchema = pgSchema('promotions');
export type JsonObject = Record<string, unknown>;

export const promotions = promotionsSchema.table(
  'promotions',
  {
    id: uuid('id').notNull().defaultRandom(),
    name: text('name').notNull(),
    discountType: text('discount_type').notNull(),
    discountValue: numeric('discount_value').notNull(),
    modality: text('modality').notNull(),
    state: text('state').notNull(),
    validFrom: timestamp('valid_from', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    validUntil: timestamp('valid_until', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    priority: integer('priority').notNull(),
    enabledChannels: text('enabled_channels').array().notNull(),
    firstActivatedAt: timestamp('first_activated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_promotions', columns: [t.id] }),
    check('ck_promotions_name', sql.raw('length(btrim(name))>0')),
    check(
      'ck_promotions_discount_type',
      sql.raw("discount_type IN ('PORCENTAJE','MONTO_FIJO')"),
    ),
    check(
      'ck_promotions_modality',
      sql.raw("modality IN ('AUTOMATICA','CUPON')"),
    ),
    check('ck_promotions_state', sql.raw("state IN ('ACTIVO','INACTIVO')")),
    check('ck_promotions_priority', sql.raw('priority>0')),
    check(
      'ck_promotions_channels',
      sql.raw('promotions.fn_valid_channels(enabled_channels)'),
    ),
    check(
      'ck_promotions_discount',
      sql.raw(
        "discount_value>0 AND discount_value NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND (discount_type<>'PORCENTAJE' OR discount_value<=100)",
      ),
    ),
    check(
      'ck_promotions_period',
      sql.raw(
        'isfinite(valid_from) AND isfinite(valid_until) AND valid_from<valid_until',
      ),
    ),
    check(
      'ck_promotions_activation',
      sql.raw("state<>'ACTIVO' OR first_activated_at IS NOT NULL"),
    ),
    index('ix_promotions_evaluation')
      .on(t.priority, t.validFrom, t.validUntil, t.id)
      .where(sql.raw("state='ACTIVO'")),
  ],
);

export const promotionScopes = promotionsSchema.table(
  'promotion_scopes',
  {
    id: uuid('id').notNull().defaultRandom(),
    promotionId: uuid('promotion_id').notNull(),
    productId: text('product_id'),
    sku: text('sku'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_promotion_scopes', columns: [t.id] }),
    foreignKey({
      name: 'fk_promotion_scopes_promotion',
      columns: [t.promotionId],
      foreignColumns: [promotions.id],
    }).onDelete('restrict'),
    check(
      'ck_promotion_scopes_reference',
      sql.raw(
        '\n    (product_id IS NOT NULL AND length(btrim(product_id))>0 AND sku IS NULL)\n    OR (sku IS NOT NULL AND length(btrim(sku))>0 AND product_id IS NULL)',
      ),
    ),
    uniqueIndex('uq_promotion_scopes_product')
      .on(t.promotionId, t.productId)
      .where(sql.raw('product_id IS NOT NULL')),
    uniqueIndex('uq_promotion_scopes_sku')
      .on(t.promotionId, t.sku)
      .where(sql.raw('sku IS NOT NULL')),
    index('ix_promotion_scopes_promotion').on(t.promotionId),
    index('ix_promotion_scopes_product')
      .on(t.productId, t.promotionId)
      .where(sql.raw('product_id IS NOT NULL')),
    index('ix_promotion_scopes_sku')
      .on(t.sku, t.promotionId)
      .where(sql.raw('sku IS NOT NULL')),
  ],
);

export const combinationPolicy = promotionsSchema.table(
  'combination_policy',
  {
    promotionId: uuid('promotion_id').notNull(),
    pricingOffer: boolean('pricing_offer').notNull(),
    automaticPromotion: boolean('automatic_promotion').notNull(),
    coupon: boolean('coupon').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_combination_policy', columns: [t.promotionId] }),
    foreignKey({
      name: 'fk_combination_policy_promotion',
      columns: [t.promotionId],
      foreignColumns: [promotions.id],
    }).onDelete('restrict'),
  ],
);

export const coupons = promotionsSchema.table(
  'coupons',
  {
    id: uuid('id').notNull().defaultRandom(),
    promotionId: uuid('promotion_id').notNull(),
    code: text('code').notNull(),
    state: text('state').notNull(),
    minimumAmount: numeric('minimum_amount'),
    maxGlobalUses: integer('max_global_uses'),
    maxCustomerUses: integer('max_customer_uses'),
    cancellationPolicy: text('cancellation_policy').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_coupons', columns: [t.id] }),
    foreignKey({
      name: 'fk_coupons_promotion',
      columns: [t.promotionId],
      foreignColumns: [promotions.id],
    }).onDelete('restrict'),
    unique('uq_coupons_code').on(t.code),
    check('ck_coupons_state', sql.raw("state IN ('ACTIVO','INACTIVO')")),
    check(
      'ck_coupons_minimum',
      sql.raw(
        "minimum_amount>0 AND minimum_amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)",
      ),
    ),
    check('ck_coupons_global', sql.raw('max_global_uses>0')),
    check('ck_coupons_customer', sql.raw('max_customer_uses>0')),
    check(
      'ck_coupons_policy',
      sql.raw(
        "cancellation_policy IN ('RESTAURAR_EN_CANCELACION','NO_RESTAURAR')",
      ),
    ),
    check(
      'ck_coupons_code',
      sql.raw(
        'code=promotions.fn_normalize_code(code) AND code COLLATE "C" ~ \'^[A-Z0-9_-]+$\'',
      ),
    ),
    index('ix_coupons_promotion').on(t.promotionId),
  ],
);

export const couponUses = promotionsSchema.table(
  'coupon_uses',
  {
    id: uuid('id').notNull().defaultRandom(),
    couponId: uuid('coupon_id').notNull(),
    promotionId: uuid('promotion_id').notNull(),
    orderId: text('order_id').notNull(),
    customerRef: uuid('customer_ref'),
    channelId: text('channel_id').notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    cancellationPolicy: text('cancellation_policy').notNull(),
    restoredAt: timestamp('restored_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_coupon_uses', columns: [t.id] }),
    foreignKey({
      name: 'fk_coupon_uses_coupon',
      columns: [t.couponId],
      foreignColumns: [coupons.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_coupon_uses_promotion',
      columns: [t.promotionId],
      foreignColumns: [promotions.id],
    }).onDelete('restrict'),
    check('ck_coupon_uses_order', sql.raw('length(btrim(order_id))>0')),
    check(
      'ck_coupon_uses_channel',
      sql.raw("channel_id IN ('MARKETPLACE','CHATBOT','RETAIL')"),
    ),
    check('ck_coupon_uses_consumed', sql.raw('isfinite(consumed_at)')),
    check(
      'ck_coupon_uses_policy',
      sql.raw(
        "cancellation_policy IN ('RESTAURAR_EN_CANCELACION','NO_RESTAURAR')",
      ),
    ),
    unique('uq_coupon_uses_order_coupon').on(t.orderId, t.couponId),
    check(
      'ck_coupon_uses_restored',
      sql.raw(
        "restored_at IS NULL OR (isfinite(restored_at) AND restored_at>=consumed_at AND cancellation_policy='RESTAURAR_EN_CANCELACION')",
      ),
    ),
    index('ix_coupon_uses_coupon').on(t.couponId),
    index('ix_coupon_uses_promotion').on(t.promotionId),
    index('ix_coupon_uses_capacity')
      .on(t.couponId, t.customerRef)
      .where(sql.raw('restored_at IS NULL')),
  ],
);

export const recommendationRules = promotionsSchema.table(
  'recommendation_rules',
  {
    id: uuid('id').notNull().defaultRandom(),
    name: text('name').notNull(),
    recommendationType: text('recommendation_type').notNull(),
    originType: text('origin_type').notNull(),
    originId: text('origin_id').notNull(),
    priority: integer('priority').notNull(),
    state: text('state').notNull(),
    validFrom: timestamp('valid_from', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    validUntil: timestamp('valid_until', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_recommendation_rules', columns: [t.id] }),
    check('ck_recommendation_rules_name', sql.raw('length(btrim(name))>0')),
    check(
      'ck_recommendation_rules_type',
      sql.raw("recommendation_type IN ('CROSS_SELL','UPSELL')"),
    ),
    check(
      'ck_recommendation_rules_origin_type',
      sql.raw("origin_type IN ('PRODUCTO','CATEGORIA')"),
    ),
    check(
      'ck_recommendation_rules_origin',
      sql.raw('length(btrim(origin_id))>0'),
    ),
    check('ck_recommendation_rules_priority', sql.raw('priority>0')),
    check(
      'ck_recommendation_rules_state',
      sql.raw("state IN ('ACTIVO','INACTIVO')"),
    ),
    check(
      'ck_recommendation_rules_period',
      sql.raw(
        'isfinite(valid_from) AND isfinite(valid_until) AND valid_from<valid_until',
      ),
    ),
    index('ix_recommendation_rules_origin')
      .on(t.originType, t.originId, t.priority, t.id)
      .where(sql.raw("state='ACTIVO'")),
  ],
);

export const recommendationItems = promotionsSchema.table(
  'recommendation_items',
  {
    id: uuid('id').notNull().defaultRandom(),
    ruleId: uuid('rule_id').notNull(),
    productId: text('product_id').notNull(),
    itemOrder: integer('item_order').notNull(),
    superiorityCriterion: text('superiority_criterion'),
    commercialJustification: text('commercial_justification'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_recommendation_items', columns: [t.id] }),
    foreignKey({
      name: 'fk_recommendation_items_rule',
      columns: [t.ruleId],
      foreignColumns: [recommendationRules.id],
    }).onDelete('restrict'),
    check(
      'ck_recommendation_items_product',
      sql.raw('length(btrim(product_id))>0'),
    ),
    check('ck_recommendation_items_order', sql.raw('item_order>0')),
    check(
      'ck_recommendation_items_criterion',
      sql.raw(
        "superiority_criterion IN ('MAYOR_RENDIMIENTO','MEJOR_MATERIAL','MAYOR_CAPACIDAD','FUNCIONALIDAD_ADICIONAL')",
      ),
    ),
    check(
      'ck_recommendation_items_justification',
      sql.raw('length(commercial_justification)<=500'),
    ),
    unique('uq_recommendation_items_product').on(t.ruleId, t.productId),
    index('ix_recommendation_items_order').on(t.ruleId, t.itemOrder, t.id),
  ],
);

export const catalogProjection = promotionsSchema.table(
  'catalog_projection',
  {
    referenceType: text('reference_type').notNull(),
    referenceId: text('reference_id').notNull(),
    productId: text('product_id').notNull(),
    active: boolean('active').notNull(),
    snapshot: jsonb('snapshot').$type<JsonObject>().notNull(),
    sourceVersion: bigint('source_version', { mode: 'bigint' }),
    sourceOccurredAt: timestamp('source_occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'ck_catalog_projection_type',
      sql.raw("reference_type IN ('PRODUCTO','SKU')"),
    ),
    check(
      'ck_catalog_projection_reference',
      sql.raw('length(btrim(reference_id))>0'),
    ),
    check(
      'ck_catalog_projection_product',
      sql.raw('length(btrim(product_id))>0'),
    ),
    check(
      'ck_catalog_projection_snapshot',
      sql.raw("jsonb_typeof(snapshot)='object'"),
    ),
    check('ck_catalog_projection_version', sql.raw('source_version>0')),
    check(
      'ck_catalog_projection_time',
      sql.raw('isfinite(source_occurred_at)'),
    ),
    check(
      'ck_catalog_projection_message',
      sql.raw('length(btrim(source_message_id))>0'),
    ),
    primaryKey({
      name: 'pk_catalog_projection',
      columns: [t.referenceType, t.referenceId],
    }),
    check(
      'ck_catalog_projection_product_identity',
      sql.raw("reference_type<>'PRODUCTO' OR reference_id=product_id"),
    ),
    index('ix_catalog_projection_product').on(t.productId),
  ],
);

export const priceProjection = promotionsSchema.table(
  'price_projection',
  {
    sku: text('sku').notNull(),
    channelId: text('channel_id'),
    snapshot: jsonb('snapshot').$type<JsonObject>().notNull(),
    sourceVersion: bigint('source_version', { mode: 'bigint' }),
    sourceOccurredAt: timestamp('source_occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    id: uuid('id').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('ck_price_projection_sku', sql.raw('length(btrim(sku))>0')),
    check(
      'ck_price_projection_channel',
      sql.raw("channel_id IN ('MARKETPLACE','CHATBOT','RETAIL','VENTAS')"),
    ),
    check(
      'ck_price_projection_snapshot',
      sql.raw("jsonb_typeof(snapshot)='object'"),
    ),
    check('ck_price_projection_version', sql.raw('source_version>0')),
    check('ck_price_projection_time', sql.raw('isfinite(source_occurred_at)')),
    check(
      'ck_price_projection_message',
      sql.raw('length(btrim(source_message_id))>0'),
    ),
    primaryKey({ name: 'pk_price_projection', columns: [t.id] }),
    unique('uq_price_projection_sku_channel')
      .on(t.sku, t.channelId)
      .nullsNotDistinct(),
  ],
);

export const stockProjection = promotionsSchema.table(
  'stock_projection',
  {
    sku: text('sku').notNull(),
    availability: text('availability').notNull(),
    snapshot: jsonb('snapshot').$type<JsonObject>().notNull(),
    sourceVersion: bigint('source_version', { mode: 'bigint' }),
    sourceOccurredAt: timestamp('source_occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_stock_projection', columns: [t.sku] }),
    check('ck_stock_projection_sku', sql.raw('length(btrim(sku))>0')),
    check(
      'ck_stock_projection_availability',
      sql.raw("availability IN ('DISPONIBLE','STOCK_BAJO','AGOTADO')"),
    ),
    check(
      'ck_stock_projection_snapshot',
      sql.raw("jsonb_typeof(snapshot)='object'"),
    ),
    check('ck_stock_projection_version', sql.raw('source_version>0')),
    check('ck_stock_projection_time', sql.raw('isfinite(source_occurred_at)')),
    check(
      'ck_stock_projection_message',
      sql.raw('length(btrim(source_message_id))>0'),
    ),
  ],
);

export const outbox = promotionsSchema.table(
  'outbox',
  {
    messageId: text('message_id').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    operationId: uuid('operation_id'),
    producer: text('producer').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    data: jsonb('data').$type<JsonObject>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'string',
    }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({ name: 'pk_outbox', columns: [t.messageId] }),
    check('ck_outbox_message', sql.raw('length(btrim(message_id))>0')),
    check('ck_outbox_version', sql.raw('schema_version>0')),
    check('ck_outbox_time', sql.raw('isfinite(occurred_at)')),
    check('ck_outbox_correlation', sql.raw('length(btrim(correlation_id))>0')),
    check('ck_outbox_producer', sql.raw("producer='promotions-svc'")),
    check('ck_outbox_kind', sql.raw("kind IN ('event','command','result')")),
    check('ck_outbox_name', sql.raw('length(btrim(name))>0')),
    check('ck_outbox_data', sql.raw("jsonb_typeof(data)='object'")),
    check('ck_outbox_attempts', sql.raw('attempts>=0')),
    check(
      'ck_outbox_published',
      sql.raw(
        'published_at IS NULL OR (isfinite(published_at) AND published_at>=created_at)',
      ),
    ),
    index('ix_outbox_pending')
      .on(t.createdAt, t.messageId)
      .where(sql.raw('published_at IS NULL')),
  ],
);

export const inbox = promotionsSchema.table(
  'inbox',
  {
    messageId: text('message_id').notNull(),
    handler: text('handler').notNull(),
    envelope: jsonb('envelope').$type<JsonObject>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    result: jsonb('result').$type<JsonObject>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('ck_inbox_message', sql.raw('length(btrim(message_id))>0')),
    check('ck_inbox_handler', sql.raw('length(btrim(handler))>0')),
    check(
      'ck_inbox_envelope',
      sql.raw(
        "promotions.fn_valid_envelope(envelope) AND envelope->>'message_id'=message_id",
      ),
    ),
    primaryKey({ name: 'pk_inbox', columns: [t.messageId, t.handler] }),
    check(
      'ck_inbox_result',
      sql.raw(
        "(completed_at IS NULL AND result IS NULL) OR\n    (completed_at IS NOT NULL AND isfinite(completed_at) AND completed_at>=received_at AND result IS NOT NULL AND jsonb_typeof(result)='object')",
      ),
    ),
  ],
);

export const couponCommandReceipts = promotionsSchema.table(
  'coupon_command_receipts',
  {
    operationId: uuid('operation_id').notNull(),
    orderId: text('order_id').notNull(),
    sourceClientId: text('source_client_id').notNull(),
    intention: text('intention').notNull(),
    couponCode: text('coupon_code'),
    reservationId: uuid('reservation_id'),
    commercialSnapshotRef: text('commercial_snapshot_ref'),
    requestFingerprint: text('request_fingerprint').notNull(),
    requestPayload: jsonb('request_payload').$type<JsonObject>().notNull(),
    status: text('status').notNull().default('RECIBIDO'),
    resultPayload: jsonb('result_payload').$type<JsonObject>(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (t) => [
    primaryKey({
      name: 'coupon_command_receipts_pkey',
      columns: [t.operationId],
    }),
    check(
      'coupon_command_receipts_order_id_check',
      sql.raw('length(btrim(order_id))>0'),
    ),
    check(
      'coupon_command_receipts_source_client_id_check',
      sql.raw('length(btrim(source_client_id))>0'),
    ),
    check(
      'coupon_command_receipts_intention_check',
      sql.raw("intention IN ('CONSUMIR','RESTAURAR')"),
    ),
    check(
      'coupon_command_receipts_request_fingerprint_check',
      sql.raw("request_fingerprint ~ '^[0-9a-f]{64}$'"),
    ),
    check(
      'coupon_command_receipts_request_payload_check',
      sql.raw("jsonb_typeof(request_payload)='object'"),
    ),
    check(
      'coupon_command_receipts_status_check',
      sql.raw("status IN ('RECIBIDO','COMPLETED','REJECTED')"),
    ),
    check(
      'ck_coupon_command_complete',
      sql.raw(
        "\n       (status = 'RECIBIDO' AND completed_at IS NULL AND result_payload IS NULL)\n       OR (status IN ('COMPLETED','REJECTED')\n          AND completed_at IS NOT NULL AND result_payload IS NOT NULL\n          AND jsonb_typeof(result_payload)='object')",
      ),
    ),
    check(
      'ck_coupon_command_consumption_context',
      sql.raw(
        "\n       intention <> 'CONSUMIR' OR\n       (coupon_code IS NOT NULL AND length(btrim(coupon_code))>0\n        AND reservation_id IS NOT NULL\n        AND commercial_snapshot_ref IS NOT NULL\n        AND length(btrim(commercial_snapshot_ref))>0)",
      ),
    ),
    index('ix_coupon_command_receipts_order').on(t.orderId),
    index('ix_coupon_command_receipts_received').on(t.receivedAt),
  ],
);
