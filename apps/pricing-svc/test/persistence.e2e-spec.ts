import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PricingSvcModule } from '../src/pricing-svc.module.js';
import {
  PricingDatabase,
  type PricingTransaction,
} from '../src/persistence/pricing.database.js';
import {
  PricingRepository,
  MAX_INLINE_IMPORT_ROWS,
} from '../src/persistence/pricing.repository.js';
import { PricingPersistenceError } from '../src/persistence/persistence.error.js';
import {
  prices,
  priceValidities,
  scheduledPrices,
  bulkPriceJobs,
  bulkPriceRows,
  outbox,
  inbox,
  pricingSchema,
} from '../src/persistence/pricing.schema.js';
import { IsolatedPostgres } from './isolated-postgres.js';
import { SignedUser } from './signed-user.js';
import { PricingMutations } from '../src/application/pricing-mutations.js';
import { PricingScheduleReconciler } from '../src/messaging/schedule-reconciler.js';
import { PricingProductInitialization } from '../src/messaging/pricing-initialization.js';
import { CatalogSkuDeactivated } from '../src/messaging/catalog-sku-deactivated.js';
import {
  CommercialPrices,
  PRICING_CATALOG_CONTEXT,
  type PricingCatalogContext,
} from '../src/http/commercial-prices.js';
import {
  PRICING_FACT_FACTORY,
  PRICING_WRITE_AUTHORIZER,
  type PricingFactFactory,
} from '../src/http/pricing-write.controller.js';
import { PricingHttpError } from '../src/http/pricing-http.error.js';
import {
  changePrice,
  initializeProduct,
  schedulePrice,
  type PriceDefinition,
} from '../src/domain/price.js';

describe.skipIf(process.env.PRICING_TEST_POSTGRES !== '1')(
  'Pricing Drizzle / PostgreSQL aislado (#53)',
  () => {
    const postgres = new IsolatedPostgres();
    const identity = new SignedUser();
    let app: INestApplication<App> | undefined;
    let repository: PricingRepository;
    let database: PricingDatabase;
    let mutations: PricingMutations;
    let reconciler: PricingScheduleReconciler;
    let initialization: PricingProductInitialization;
    let deactivation: CatalogSkuDeactivated;
    const contexts = new Map<
      string,
      NonNullable<Awaited<ReturnType<PricingCatalogContext['resolve']>>>
    >();
    const retailChannel = 'RETAIL';
    let denyWrite = false;
    const actor = '74ed2f19-7e70-4915-a6f6-bbc691b82587';
    const factFactory: PricingFactFactory = (before, after, metadata) => {
      const current = after.validities.find(
        (v) => v.priceVersion === after.priceVersion,
      )!;
      if (current.motivoCambio === 'fixture-fact-failure')
        throw new Error('Fallo de factory de prueba');
      // Fixture de atomicidad: no es el payload P-PRI-02 aprobado.
      return {
        messageId: randomUUID(),
        correlationId: metadata.correlationId,
        payload: {
          fixture_only: true,
          before: before.priceVersion.toString(),
          after: after.priceVersion.toString(),
        },
      };
    };
    const from = new Date('2030-01-01T00:00:00Z');
    const boundary = new Date('2031-01-01T00:00:00Z');
    const snapshot = (priceId: string, version = 1n) => ({
      priceId,
      precioRegular: '99.99',
      precioOferta: '80.25',
      currency: 'PEN',
      validFrom: from,
      priceVersion: version,
      motivoCambio: 'fixture',
      usuarioId: 'fixture-actor',
    });
    const event = () => ({
      messageId: randomUUID(),
      eventName: 'pricing.price.changed',
      kind: 'event',
      correlationId: randomUUID(),
      occurredAt: from,
      payload: {},
    });

    async function create(
      tx: PricingTransaction,
      target: { productId: string } | { sku: string } = {
        productId: randomUUID(),
      },
      channelId: string | null = null,
    ) {
      const [definition] = await tx
        .insert(prices)
        .values({ ...target, channelId })
        .returning();
      const [validity] = await tx
        .insert(priceValidities)
        .values(snapshot(definition.id))
        .returning();
      return { definition, validity };
    }

    async function seedScheduledSku(
      sku: string,
      validFrom: Date,
      validUntil: Date | null = null,
      channelId: string | null = null,
    ) {
      const productId = randomUUID();
      const correlationId = randomUUID();
      const created = await repository.transaction(async (tx) => {
        const target = await create(tx, { sku }, channelId);
        await tx
          .update(priceValidities)
          .set({ validUntil: validFrom })
          .where(eq(priceValidities.id, target.validity.id));
        await tx
          .update(prices)
          .set({ priceVersion: 2n })
          .where(eq(prices.id, target.definition.id));
        const [validity] = await tx
          .insert(priceValidities)
          .values({
            ...snapshot(target.definition.id, 2n),
            precioRegular: '110.00',
            precioOferta: null,
            validFrom,
            validUntil,
            motivoCambio: 'PRI-010 fixture schedule',
          })
          .returning();
        const [schedule] = await tx
          .insert(scheduledPrices)
          .values({
            priceId: target.definition.id,
            validityId: validity.id,
            productId,
            correlationId,
            tipoPrecio: 'REGULAR',
            importe: '110.00',
            status: 'SCHEDULED',
          })
          .returning();
        return { schedule, validity, price: target.definition };
      });
      return { ...created, productId, correlationId };
    }

    function skuDeactivationMessage(
      sku: string,
      productId: string,
      skuVersion: number,
      changedAt: Date,
      messageId = randomUUID(),
    ) {
      return {
        message_id: messageId,
        schema_version: 1,
        occurred_at: changedAt.toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku,
          product_id: productId,
          sku_version: skuVersion,
          changed_at: changedAt.toISOString(),
        },
      };
    }

    beforeAll(async () => {
      await postgres.start();
      await identity.start();
      const version = await postgres.admin!.query<{ server_version: string }>(
        'SHOW server_version',
      );
      console.info(
        `PostgreSQL aislado ${version.rows[0].server_version}; runtime pricing_app; SQL normativo c36bd9a.`,
      );
      const module = await Test.createTestingModule({
        imports: [
          PricingSvcModule.forRoot({
            NODE_ENV: 'test',
            PRICING_SVC_PORT: '3002',
            DATABASE_URL: postgres.runtimeUrl,
            PGSSLMODE: 'disable',
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: identity.issuer + '/jwks',
          }),
        ],
      })
        .overrideProvider(PRICING_CATALOG_CONTEXT)
        .useValue({ resolve: async (sku: string) => contexts.get(sku) ?? null })
        .overrideProvider(PRICING_WRITE_AUTHORIZER)
        .useValue(async () => {
          if (denyWrite) throw new PricingHttpError(403, 'SCOPE_INSUFICIENTE');
          return actor; // Introspección G7 simulada explícitamente, no grant real.
        })
        .overrideProvider(PRICING_FACT_FACTORY)
        .useValue(factFactory)
        .compile();
      database = module.get(PricingDatabase);
      repository = module.get(PricingRepository);
      mutations = module.get(PricingMutations);
      reconciler = module.get(PricingScheduleReconciler);
      initialization = module.get(PricingProductInitialization);
      deactivation = module.get(CatalogSkuDeactivated);
      app = module.createNestApplication();
      await app.init();
    }, 90000);

    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        try {
          await identity.stop();
        } finally {
          await postgres.stop();
        }
      }
    }, 30000);

    it('HTTP resuelve SKU, herencia/override, canal canónico, vigencia y versión reales sin consultas cross-schema', async () => {
      const productId = randomUUID();
      const simpleSku = 'SIMPLE-' + randomUUID();
      const variantSku = 'VARIANT-' + randomUUID();
      const inheritedSku = 'INHERITED-' + randomUUID();
      const scopedSku = 'SCOPED-' + randomUUID();
      const fallbackSku = 'FALLBACK-' + randomUUID();
      const fallbackProductId = randomUUID();
      for (const [sku, isVariant] of [
        [simpleSku, false],
        [variantSku, true],
        [inheritedSku, true],
        [scopedSku, true],
      ] as const)
        contexts.set(sku, {
          sku,
          productId,
          isVariant,
          active: true,
          eligible: true,
        });
      contexts.set(fallbackSku, {
        sku: fallbackSku,
        productId: fallbackProductId,
        isVariant: true,
        active: true,
        eligible: true,
      });
      const stored = await repository.transaction(async (tx) => {
        const global = await create(tx, { productId });
        const retail = await create(tx, { productId }, retailChannel);
        await tx
          .update(priceValidities)
          .set({ precioRegular: '77.77', precioOferta: null })
          .where(eq(priceValidities.id, retail.validity.id));
        const override = await create(tx, { sku: variantSku });
        await tx
          .update(priceValidities)
          .set({ precioRegular: '55.55', precioOferta: null })
          .where(eq(priceValidities.id, override.validity.id));
        const scoped = await create(tx, { sku: scopedSku }, retailChannel);
        await tx
          .update(priceValidities)
          .set({ precioRegular: '33.33', precioOferta: null })
          .where(eq(priceValidities.id, scoped.validity.id));
        const fallback = await create(tx, { productId: fallbackProductId });
        return { global, retail, override, scoped, fallback };
      });
      const get = (path: string, token = identity.token()) =>
        request(app!.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer ' + token);
      const at = '2030-06-01T00:00:00Z';
      expect(
        (await get(`/api/v1/precios/skus/${simpleSku}?at=${at}`).expect(200))
          .body,
      ).toMatchObject({
        sku: simpleSku,
        origen: 'PRODUCTO',
        precio_regular: 99.99,
        vigencia_id: stored.global.validity.id,
        price_version: 1,
        channel_id: null,
      });
      expect(
        (
          await get(
            `/api/v1/precios/skus/${variantSku}?at=${at}&canal=RETAIL`,
          ).expect(200)
        ).body,
      ).toMatchObject({
        origen: 'SKU_OVERRIDE',
        precio_regular: 55.55,
        vigencia_id: stored.override.validity.id,
        channel_id: null,
      });
      const serviceToken = identity.token({
        tipo: 'servicio',
        sub: 'modulo-marketplace',
        aud: 'api-productos',
        scope: 'precios:leer',
        roles: undefined,
      });
      expect(
        (
          await get(
            `/api/v1/precios/skus/${inheritedSku}?at=${at}&canal=RETAIL`,
            serviceToken,
          ).expect(200)
        ).body,
      ).toMatchObject({
        origen: 'PRODUCTO',
        precio_regular: 77.77,
        vigencia_id: stored.retail.validity.id,
        channel_id: 'RETAIL',
      });
      const commercialCases = [
        {
          sku: simpleSku,
          origen: 'PRODUCTO',
          channel_id: 'RETAIL',
          precio_regular: 77.77,
        },
        {
          sku: inheritedSku,
          origen: 'PRODUCTO',
          channel_id: 'RETAIL',
          precio_regular: 77.77,
        },
        {
          sku: variantSku,
          origen: 'SKU_OVERRIDE',
          channel_id: null,
          precio_regular: 55.55,
        },
        {
          sku: scopedSku,
          origen: 'SKU_OVERRIDE',
          channel_id: 'RETAIL',
          precio_regular: 33.33,
        },
        {
          sku: fallbackSku,
          origen: 'PRODUCTO',
          channel_id: null,
          precio_regular: 99.99,
        },
      ];
      for (const expected of commercialCases) {
        const response = await get(
          `/api/v1/precios/skus/${expected.sku}?at=${at}&canal=RETAIL`,
        ).expect(200);
        expect(response.body).toMatchObject(expected);
        expect([null, 'MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS']).toContain(
          response.body.channel_id,
        );
      }
      const scopedBatch = await get(
        `/api/v1/precios?skus=${commercialCases.map((c) => c.sku).join(',')}&at=${at}&canal=RETAIL`,
      ).expect(200);
      expect(scopedBatch.body.items).toMatchObject(commercialCases);
      for (const item of scopedBatch.body.items) {
        expect([null, 'MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS']).toContain(
          item.channel_id,
        );
      }
      await get(`/api/v1/precios/productos/${productId}`, serviceToken).expect(
        401,
      );
      await get(
        `/api/v1/precios/skus/${simpleSku}?at=2029-01-01T00:00:00Z`,
      ).expect(404);
      await get(
        `/api/v1/precios/skus/${simpleSku}?at=${at}&canal=MARKETPLACE`,
      ).expect(200);
      const batch = await get(
        `/api/v1/precios?skus=${simpleSku},missing,${variantSku}&at=${at}`,
      ).expect(200);
      expect(batch.body.items.map((item: { sku: string }) => item.sku)).toEqual(
        [simpleSku, variantSku],
      );
      contexts.set(simpleSku, {
        sku: simpleSku,
        productId,
        isVariant: false,
        active: false,
        eligible: false,
      });
      await get(`/api/v1/precios/skus/${simpleSku}?at=${at}`).expect(404);
      await expect(
        new CommercialPrices(repository).sku(
          simpleSku,
          undefined,
          new Date(at),
        ),
      ).rejects.toMatchObject({ status: 503 });
    });

    it('consume inicialización Catalog con Inbox, precio y hechos/resultados Outbox atómicos e idempotentes', async () => {
      const productId = randomUUID();
      const operationId = randomUUID();
      const correlationId = randomUUID();
      const messageId = randomUUID();
      const occurredAt = new Date(Date.now() - 5000).toISOString();
      const envelope = (id: string, precio_regular: number) => ({
        message_id: id,
        schema_version: 1,
        occurred_at: occurredAt,
        correlation_id: correlationId,
        causation_id: null,
        operation_id: operationId,
        producer: 'catalog-svc',
        kind: 'command',
        name: 'pricing.product.initialization.requested',
        data: {
          product_id: productId,
          sku_base: 'BASE-' + productId,
          precio_regular,
          moneda: 'PEN',
          channel_id: null,
          motivo_cambio: 'ALTA_PRODUCTO',
        },
      });
      const first = envelope(messageId, 125.5);
      expect(
        await initialization.consume(Buffer.from(JSON.stringify(first))),
      ).toBe('APPLIED');
      expect(
        await initialization.consume(Buffer.from(JSON.stringify(first))),
      ).toBe('APPLIED');
      expect(
        await initialization.consume(
          Buffer.from(JSON.stringify(envelope(randomUUID(), 125.5))),
        ),
      ).toBe('DUPLICATE');
      const conflict = envelope(randomUUID(), 140);
      expect(
        await initialization.consume(Buffer.from(JSON.stringify(conflict))),
      ).toBe('REJECTED');

      const definitions = await database.db
        .select()
        .from(prices)
        .where(eq(prices.productId, productId));
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        sku: null,
        channelId: null,
        priceVersion: 1n,
      });
      const snapshots = await repository.findValidities(definitions[0].id);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        precioRegular: '125.50',
        motivoCambio: 'ALTA_PRODUCTO',
        usuarioId: null,
      });
      const messages = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.operationId, operationId));
      expect(messages.map((row) => row.eventName).sort()).toEqual([
        'pricing.price.changed',
        'pricing.product.initialization.completed',
        'pricing.product.initialization.completed',
        'pricing.product.initialization.rejected',
      ]);
      expect(
        messages.find((row) => row.eventName === 'pricing.price.changed')
          ?.payload,
      ).toMatchObject({
        target_type: 'PRODUCTO',
        product_id: productId,
        price_type: 'REGULAR',
        previous_price: null,
        new_price: '125.50',
        price_version: 1,
        actor: { user_id: null, email: null, ip: null },
      });
      const sameIntent = await initialization.consume(
        Buffer.from(JSON.stringify(envelope(randomUUID(), 125.5))),
      );
      expect(sameIntent).toBe('DUPLICATE');
      const replayedResults = await database.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.operationId, operationId),
            eq(outbox.kind, 'result'),
            eq(outbox.eventName, 'pricing.product.initialization.completed'),
          ),
        );
      expect(replayedResults).toHaveLength(3);
    });

    it('cancela solo programaciones futuras del SKU por versión; duplicados y versiones obsoletas no repiten efectos', async () => {
      const productId = randomUUID();
      const sku = 'DEACTIVATE-' + randomUUID();
      const siblingSku = 'SIBLING-' + randomUUID();
      const now = new Date('2034-01-01T00:00:00Z');
      const future = new Date('2035-01-01T00:00:00Z');
      const inserted = await repository.transaction(async (tx) => {
        const target = await create(tx, { sku });
        const sibling = await create(tx, { sku: siblingSku });
        const base = await create(tx, { productId });
        const rows: (typeof scheduledPrices.$inferSelect)[] = [];
        for (const item of [target, sibling, base]) {
          await tx
            .update(prices)
            .set({ priceVersion: 2n })
            .where(eq(prices.id, item.definition.id));
          await tx
            .update(priceValidities)
            .set({ validUntil: future })
            .where(eq(priceValidities.id, item.validity.id));
          const [validity] = await tx
            .insert(priceValidities)
            .values({
              priceId: item.definition.id,
              precioRegular: '130.00',
              precioOferta: null,
              currency: 'PEN',
              validFrom: future,
              validUntil: null,
              priceVersion: 2n,
              motivoCambio: 'FUTURA',
              usuarioId: actor,
            })
            .returning();
          const [schedule] = await tx
            .insert(scheduledPrices)
            .values({
              priceId: item.definition.id,
              validityId: validity.id,
              productId: item.definition.productId,
              correlationId: randomUUID(),
              tipoPrecio: 'REGULAR',
              importe: '130.00',
              status: 'SCHEDULED',
            })
            .returning();
          rows.push(schedule);
        }
        return rows;
      });
      const overdue = await seedScheduledSku(
        sku,
        new Date(now.getTime() - 60_000),
        new Date(now.getTime() + 3_600_000),
        'OVERDUE-CHANNEL',
      );
      const makeMessage = (
        messageId: string,
        version: number,
        changedAt: Date,
      ) => ({
        message_id: messageId,
        schema_version: 1,
        occurred_at: now.toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku,
          product_id: productId,
          sku_version: version,
          changed_at: changedAt.toISOString(),
        },
      });
      const first = makeMessage(randomUUID(), 2, now);
      expect(
        await deactivation.consume(Buffer.from(JSON.stringify(first))),
      ).toBe('APPLIED');
      expect(
        await deactivation.consume(Buffer.from(JSON.stringify(first))),
      ).toBe('DUPLICATE');
      const stale = makeMessage(randomUUID(), 1, now);
      expect(
        await deactivation.consume(Buffer.from(JSON.stringify(stale))),
      ).toBe('STALE');
      const statuses = await database.db
        .select({ id: scheduledPrices.id, status: scheduledPrices.status })
        .from(scheduledPrices)
        .where(
          inArray(
            scheduledPrices.id,
            inserted.map((row) => row.id),
          ),
        );
      expect(statuses.find((row) => row.id === inserted[0].id)?.status).toBe(
        'CANCELLED',
      );
      expect(statuses.find((row) => row.id === inserted[1].id)?.status).toBe(
        'SCHEDULED',
      );
      expect(statuses.find((row) => row.id === inserted[2].id)?.status).toBe(
        'SCHEDULED',
      );
      expect(
        await database.db
          .select({ status: scheduledPrices.status })
          .from(scheduledPrices)
          .where(eq(scheduledPrices.id, overdue.schedule.id)),
      ).toEqual([{ status: 'HISTORICAL' }]);
      expect(
        await database.db
          .select({ isCancelled: priceValidities.isCancelled })
          .from(priceValidities)
          .where(eq(priceValidities.id, overdue.validity.id)),
      ).toEqual([{ isCancelled: false }]);
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.correlationId, overdue.correlationId)),
      ).toHaveLength(0);
      const invalid = makeMessage(randomUUID(), 3, now);
      delete invalid.data.sku_version;
      expect(
        await deactivation.consume(Buffer.from(JSON.stringify(invalid))),
      ).toBe('REJECTED');
    });

    it('espera una fila bloqueada y solo registra APPLIED tras cancelar todas las programaciones', async () => {
      const sku = 'LOCKED-DEACTIVATE-' + randomUUID();
      const productId = randomUUID();
      const now = new Date('2034-01-01T00:00:00Z');
      const future = new Date('2035-01-01T00:00:00Z');
      const { schedule } = await repository.transaction(async (tx) => {
        const target = await create(tx, { sku });
        await tx
          .update(prices)
          .set({ priceVersion: 2n })
          .where(eq(prices.id, target.definition.id));
        await tx
          .update(priceValidities)
          .set({ validUntil: future })
          .where(eq(priceValidities.id, target.validity.id));
        const [validity] = await tx
          .insert(priceValidities)
          .values({
            ...snapshot(target.definition.id, 2n),
            validFrom: future,
            validUntil: null,
          })
          .returning();
        const [schedule] = await tx
          .insert(scheduledPrices)
          .values({
            priceId: target.definition.id,
            validityId: validity.id,
            productId,
            correlationId: randomUUID(),
            tipoPrecio: 'REGULAR',
            importe: '99.99',
          })
          .returning();
        return { schedule };
      });
      const message = {
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: now.toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku,
          product_id: productId,
          sku_version: 2,
          changed_at: now.toISOString(),
        },
      };
      const blocker = await postgres.admin!.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM pricing.scheduled_prices WHERE id = $1 FOR UPDATE',
        [schedule.id],
      );
      try {
        const processing = deactivation.consume(
          Buffer.from(JSON.stringify(message)),
        );
        let settled = false;
        void processing.finally(() => {
          settled = true;
        });
        for (let attempt = 0; attempt < 40; attempt++) {
          const waiting = await postgres.admin!.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
          );
          if (waiting.rows[0].n > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(settled).toBe(false);
        expect(
          await database.db
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.messageId, message.message_id),
                eq(inbox.result, 'APPLIED'),
              ),
            ),
        ).toHaveLength(0);
        await blocker.query('COMMIT');
        expect(await processing).toBe('APPLIED');
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
      expect(
        await database.db
          .select()
          .from(scheduledPrices)
          .where(eq(scheduledPrices.id, schedule.id)),
      ).toMatchObject([{ status: 'CANCELLED' }]);
      expect(
        await database.db
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, message.message_id),
              eq(inbox.result, 'APPLIED'),
            ),
          ),
      ).toHaveLength(1);
    });

    it('PRI-010: baja primero y reconciliador reiniciado nunca publica una programación vencida pendiente', async () => {
      const sku = 'PRI010-RESTART-' + randomUUID();
      const changedAt = new Date('2034-01-02T00:00:00.000Z');
      const validFrom = new Date('2034-01-01T00:00:00.000Z');
      const now = new Date('2034-01-03T00:00:00.000Z');
      const pending = await seedScheduledSku(sku, validFrom);
      const message = skuDeactivationMessage(
        sku,
        pending.productId,
        3,
        changedAt,
      );

      expect(
        await deactivation.consume(Buffer.from(JSON.stringify(message))),
      ).toBe('APPLIED');
      const restarted = new PricingScheduleReconciler(repository, {
        nodeEnv: 'test',
        port: 3002,
        databaseUrl: postgres.runtimeUrl,
        databaseSsl: false,
      });
      await expect(restarted.runOnce(now)).resolves.toMatchObject({
        activated: 0,
      });
      expect(
        await database.db
          .select({ status: scheduledPrices.status })
          .from(scheduledPrices)
          .where(eq(scheduledPrices.id, pending.schedule.id)),
      ).toEqual([{ status: 'HISTORICAL' }]);
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.correlationId, pending.correlationId)),
      ).toHaveLength(0);
      expect(
        await database.db
          .select({ result: inbox.result })
          .from(inbox)
          .where(eq(inbox.messageId, message.message_id)),
      ).toEqual([{ result: 'APPLIED' }]);
    });

    it('PRI-010: reconciliación efectiva previa a baja conserva el único hecho ya producido', async () => {
      const sku = 'PRI010-ACTIVE-FIRST-' + randomUUID();
      const validFrom = new Date('2034-02-01T00:00:00.000Z');
      const pending = await seedScheduledSku(sku, validFrom);
      expect(await reconciler.runOnce(validFrom)).toMatchObject({
        activated: 1,
      });
      const existingFacts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, pending.correlationId));
      expect(existingFacts).toHaveLength(2);
      const existingFactIds = existingFacts
        .map((fact) => fact.messageId)
        .sort();
      const message = skuDeactivationMessage(
        sku,
        pending.productId,
        3,
        new Date(validFrom.getTime() + 1),
      );
      expect(
        await deactivation.consume(Buffer.from(JSON.stringify(message))),
      ).toBe('APPLIED');
      expect(
        await database.db
          .select({ status: scheduledPrices.status })
          .from(scheduledPrices)
          .where(eq(scheduledPrices.id, pending.schedule.id)),
      ).toEqual([{ status: 'ACTIVE' }]);
      const retainedFacts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, pending.correlationId));
      expect(retainedFacts.map((fact) => fact.messageId).sort()).toEqual(
        existingFactIds,
      );
    });

    it('PRI-010: dos reconciliadores concurrentes producen un solo estado ACTIVE y un solo hecho', async () => {
      const sku = 'PRI010-TWO-WORKERS-' + randomUUID();
      const validFrom = new Date('2034-03-01T00:00:00.000Z');
      const pending = await seedScheduledSku(sku, validFrom);
      const other = new PricingScheduleReconciler(repository, {
        nodeEnv: 'test',
        port: 3002,
        databaseUrl: postgres.runtimeUrl,
        databaseSsl: false,
      });
      const outcomes = await Promise.all([
        reconciler.runOnce(validFrom),
        other.runOnce(validFrom),
      ]);
      expect(outcomes.reduce((sum, result) => sum + result.activated, 0)).toBe(
        1,
      );
      expect(
        await database.db
          .select({ status: scheduledPrices.status })
          .from(scheduledPrices)
          .where(eq(scheduledPrices.id, pending.schedule.id)),
      ).toEqual([{ status: 'ACTIVE' }]);
      const facts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, pending.correlationId));
      expect(facts).toHaveLength(2);
      expect(new Set(facts.map((fact) => fact.messageId)).size).toBe(2);
    });

    it('bloquea cambios y nuevas programaciones SKU después de una baja persistida y conserva el precio base', async () => {
      const sku = 'RESTRICT-AFTER-DEACTIVATE-' + randomUUID();
      const productId = randomUUID();
      const now = new Date();
      const future = new Date(now.getTime() + 3600000);
      await repository.transaction(async (tx) => {
        const skuPrice = await create(tx, { sku });
        await tx
          .update(priceValidities)
          .set({ validFrom: new Date(now.getTime() - 60000) })
          .where(eq(priceValidities.id, skuPrice.validity.id));
        await create(tx, { productId });
      });
      const message = {
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: now.toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku,
          product_id: productId,
          sku_version: 1,
          changed_at: now.toISOString(),
        },
      };
      expect(
        await deactivation.consume(Buffer.from(JSON.stringify(message))),
      ).toBe('APPLIED');
      const before = await repository.findDefinition({ sku }, null);
      await expect(
        mutations.update(
          { sku },
          null,
          {
            precioRegular: 110,
            accionPrecioOferta: 'ELIMINAR',
            currency: 'PEN',
            motivoCambio: 'posterior a baja',
            usuarioId: actor,
          },
          1n,
          now,
          [],
        ),
      ).rejects.toMatchObject({ code: 'PRECIO_NO_ENCONTRADO' });
      await expect(
        mutations.schedule(
          { sku },
          null,
          {
            tipoPrecio: 'REGULAR',
            importe: '110.00',
            currency: 'PEN',
            motivoCambio: 'posterior a baja',
            usuarioId: actor,
            validFrom: future,
            validUntil: null,
          },
          now,
        ),
      ).rejects.toMatchObject({ code: 'PRECIO_NO_ENCONTRADO' });
      expect(await repository.findDefinition({ sku }, null)).toEqual(before);
      expect(
        await repository.findDefinition({ productId }, null),
      ).toBeDefined();
    });

    it('serializa programación y baja concurrentes: prevalece el lock y no sobrevive trabajo elegible', async () => {
      const sku = 'RACE-DEACTIVATE-' + randomUUID();
      const productId = randomUUID();
      const changedAt = new Date();
      const validFrom = new Date(changedAt.getTime() + 60000);
      await repository.transaction(async (tx) => {
        const row = await create(tx, { sku });
        await tx
          .update(priceValidities)
          .set({ validFrom: new Date(changedAt.getTime() - 60000) })
          .where(eq(priceValidities.id, row.validity.id));
        const [base] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(base.id),
          validFrom: new Date(changedAt.getTime() - 60000),
        });
      });
      const message = {
        message_id: randomUUID(),
        schema_version: 1,
        occurred_at: changedAt.toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        operation_id: randomUUID(),
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku,
          product_id: productId,
          sku_version: 1,
          changed_at: changedAt.toISOString(),
        },
      };
      const write = mutations.schedule(
        { sku },
        null,
        {
          tipoPrecio: 'REGULAR',
          importe: '110.00',
          currency: 'PEN',
          motivoCambio: 'carrera controlada',
          usuarioId: actor,
          validFrom,
          validUntil: null,
        },
        changedAt,
      );
      const removal = deactivation.consume(
        Buffer.from(JSON.stringify(message)),
      );
      const [writeResult, removalResult] = await Promise.allSettled([
        write,
        removal,
      ]);
      expect(removalResult).toMatchObject({
        status: 'fulfilled',
        value: 'APPLIED',
      });
      if (writeResult.status === 'rejected')
        expect(writeResult.reason).toMatchObject({
          code: 'PRECIO_NO_ENCONTRADO',
        });
      const schedules = await database.db
        .select({ status: scheduledPrices.status })
        .from(scheduledPrices)
        .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
        .where(eq(prices.sku, sku));
      expect(schedules.every(({ status }) => status === 'CANCELLED')).toBe(
        true,
      );
      const definition = await repository.findDefinition({ sku }, null);
      expect([1n, 2n]).toContain(definition?.priceVersion);
      expect(
        await repository.findDefinition({ productId }, null),
      ).toBeDefined();
      expect(
        await database.db
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, message.message_id),
              eq(inbox.result, 'APPLIED'),
            ),
          ),
      ).toHaveLength(1);
    });

    it('PATCH SKU conserva canal textual y rechaza canales invalidos sin efectos', async () => {
      const sku = 'PATCH-CHANNEL-' + randomUUID();
      contexts.set(sku, {
        sku,
        productId: randomUUID(),
        isVariant: true,
        active: true,
        eligible: true,
      });
      const unknownChannel = randomUUID();
      await repository.transaction(async (tx) => {
        for (const channelId of [null, retailChannel, unknownChannel]) {
          const row = await create(tx, { sku }, channelId);
          await tx
            .update(priceValidities)
            .set({ validFrom: new Date(Date.now() - 60000) })
            .where(eq(priceValidities.id, row.validity.id));
        }
      });
      const correlation = randomUUID();
      const body = {
        precioRegular: 120,
        accionPrecioOferta: 'ELIMINAR',
        moneda: 'PEN',
        motivoCambio: 'Canal contractual',
        priceVersion: 1,
      };
      const patch = (channelId: string | null) =>
        request(app!.getHttpServer())
          .patch(`/api/v1/precios/skus/${sku}`)
          .set('Authorization', 'Bearer ' + identity.token())
          .set('X-Correlation-Id', correlation)
          .send({ ...body, channelId });
      for (const [channelId, expected] of [
        [null, null],
        [retailChannel, 'RETAIL'],
      ] as const) {
        const response = await patch(channelId).expect(200);
        expect(response.body).toMatchObject({
          sku,
          channel_id: expected,
          price_version: 2,
        });
        expect(
          (await repository.findDefinition({ sku }, channelId))!.channelId,
        ).toBe(channelId);
      }
      const state = async () => {
        const definitions = await database.db
          .select()
          .from(prices)
          .where(eq(prices.sku, sku))
          .orderBy(prices.id);
        return {
          definitions,
          histories: await Promise.all(
            definitions.map((row) => repository.findValidities(row.id)),
          ),
          events: await database.db
            .select()
            .from(outbox)
            .where(eq(outbox.correlationId, correlation))
            .orderBy(outbox.id),
        };
      };
      for (const invalidChannel of [unknownChannel, 'OTHER']) {
        const before = await state();
        const update = vi.spyOn(mutations, 'update');
        try {
          const response = await patch(invalidChannel).expect(400);
          expect(response.body).toMatchObject({
            status: 400,
            code: 'VALIDACION',
            correlationId: correlation,
          });
          expect(update).not.toHaveBeenCalled();
          expect(await state()).toEqual(before);
        } finally {
          update.mockRestore();
        }
      }
      const scheduled = await request(app!.getHttpServer())
        .post(`/api/v1/precios/skus/${sku}/programaciones`)
        .set('Authorization', 'Bearer ' + identity.token())
        .send({
          channelId: retailChannel,
          tipoPrecio: 'REGULAR',
          importe: 150,
          moneda: 'PEN',
          motivoCambio: 'Canal administrativo',
          validFrom: '2035-01-01T00:00:00Z',
        })
        .expect(201);
      expect(scheduled.body.channelId).toBe(retailChannel);
    });

    it.each(['producto', 'sku'] as const)(
      'HTTP de %s conserva códigos/estados y no persiste escrituras inválidas',
      async (kind) => {
        const target =
          kind === 'producto'
            ? { productId: randomUUID() }
            : { sku: 'HTTP-STATUS-' + randomUUID() };
        const row = await repository.transaction(async (tx) => {
          const stored = await create(tx, target);
          await tx
            .update(priceValidities)
            .set({ validFrom: new Date(Date.now() - 60000) })
            .where(eq(priceValidities.id, stored.validity.id));
          return stored;
        });
        const path =
          'productId' in target
            ? `/api/v1/precios/productos/${target.productId}`
            : `/api/v1/precios/skus/${target.sku}`;
        if ('sku' in target)
          contexts.set(target.sku, {
            sku: target.sku,
            productId: randomUUID(),
            isVariant: true,
            active: true,
            eligible: true,
          });
        const jwt = 'Bearer ' + identity.token();
        const correlation = randomUUID();
        const patchBody = {
          precioRegular: 99.99,
          accionPrecioOferta: 'CONSERVAR',
          moneda: 'PEN',
          motivoCambio: 'Prueba contractual',
          priceVersion: 1,
        };
        const scheduleBody = {
          tipoPrecio: 'REGULAR',
          importe: 120,
          moneda: 'PEN',
          motivoCambio: 'Prueba contractual',
          validFrom: '2035-01-01T00:00:00Z',
        };
        const state = async () => ({
          definition: await repository.findDefinition(target, null),
          histories: await repository.findValidities(row.definition.id),
          events: await database.db
            .select()
            .from(outbox)
            .where(eq(outbox.correlationId, correlation))
            .orderBy(outbox.id),
        });
        const before = await state();
        const cases: {
          method: 'patch' | 'post';
          body: object;
          status: number;
          code: string;
        }[] = [
          {
            method: 'patch',
            body: { ...patchBody, precioRegular: 0 },
            status: 422,
            code: 'PRECIO_INVALIDO',
          },
          {
            method: 'patch',
            body: { ...patchBody, precioRegular: 100.001 },
            status: 422,
            code: 'PRECIO_INVALIDO',
          },
          {
            method: 'patch',
            body: {
              ...patchBody,
              accionPrecioOferta: 'ESTABLECER',
              precioOferta: 99.99,
            },
            status: 422,
            code: 'OFERTA_INVALIDA',
          },
          {
            method: 'patch',
            body: {
              ...patchBody,
              accionPrecioOferta: 'ESTABLECER',
              precioOferta: 100,
            },
            status: 422,
            code: 'OFERTA_INVALIDA',
          },
          {
            method: 'patch',
            body: { ...patchBody, accionPrecioOferta: 'INVALIDA' },
            status: 422,
            code: 'ACCION_OFERTA_INVALIDA',
          },
          {
            method: 'patch',
            body: { ...patchBody, priceVersion: -1 },
            status: 400,
            code: 'VALIDACION',
          },
          {
            method: 'patch',
            body: { ...patchBody, motivoCambio: '' },
            status: 400,
            code: 'VALIDACION',
          },
          {
            method: 'patch',
            body: { ...patchBody, priceVersion: 0 },
            status: 409,
            code: 'VERSION_CONFLICT',
          },
          {
            method: 'post',
            body: { ...scheduleBody, importe: 0 },
            status: 422,
            code: 'PRECIO_INVALIDO',
          },
          {
            method: 'post',
            body: { ...scheduleBody, importe: 1.001 },
            status: 422,
            code: 'PRECIO_INVALIDO',
          },
          {
            method: 'post',
            body: { ...scheduleBody, tipoPrecio: 'OFERTA', importe: 99.99 },
            status: 422,
            code: 'OFERTA_INVALIDA',
          },
          {
            method: 'post',
            body: { ...scheduleBody, tipoPrecio: 'OFERTA', importe: 100 },
            status: 422,
            code: 'OFERTA_INVALIDA',
          },
          {
            method: 'post',
            body: { ...scheduleBody, tipoPrecio: 'INVALIDO' },
            status: 400,
            code: 'VALIDACION',
          },
        ];
        for (const scenario of cases) {
          const client = request(app!.getHttpServer());
          const operation =
            scenario.method === 'patch'
              ? client.patch(path)
              : client.post(path + '/programaciones');
          const response = await operation
            .set('Authorization', jwt)
            .set('X-Correlation-Id', correlation)
            .send(scenario.body)
            .expect(scenario.status);
          expect(response.headers['content-type']).toContain(
            'application/problem+json',
          );
          expect(response.headers['x-correlation-id']).toBe(correlation);
          expect(response.body).toMatchObject({
            status: scenario.status,
            code: scenario.code,
            correlationId: correlation,
          });
          expect(await state()).toEqual(before);
        }
        await request(app!.getHttpServer())
          .post(path + '/programaciones')
          .set('Authorization', jwt)
          .set('X-Correlation-Id', correlation)
          .send(scheduleBody)
          .expect(201);
        const afterSchedule = await state();
        const overlap = await request(app!.getHttpServer())
          .post(path + '/programaciones')
          .set('Authorization', jwt)
          .set('X-Correlation-Id', correlation)
          .send({ ...scheduleBody, importe: 130 })
          .expect(409);
        expect(overlap.body).toMatchObject({
          status: 409,
          code: 'VIGENCIA_SUPERPUESTA',
          correlationId: correlation,
        });
        expect(overlap.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(await state()).toEqual(afterSchedule);
        const missingPath =
          kind === 'producto'
            ? `/api/v1/precios/productos/${randomUUID()}`
            : `/api/v1/precios/skus/missing-${randomUUID()}`;
        const missing = await request(app!.getHttpServer())
          .patch(missingPath)
          .set('Authorization', jwt)
          .set('X-Correlation-Id', correlation)
          .send(patchBody)
          .expect(404);
        expect(missing.body).toMatchObject({
          status: 404,
          code: 'PRECIO_NO_ENCONTRADO',
          correlationId: correlation,
        });
      },
    );

    it('PATCH HTTP usa actor verificado, confirma snapshot/Outbox y revierte fallo de factory sin duplicar efectos', async () => {
      const productId = randomUUID();
      await repository.transaction(async (tx) => {
        const [definition] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(definition.id),
          validFrom: new Date(Date.now() - 60000),
        });
      });
      const path = `/api/v1/precios/productos/${productId}`;
      const body = {
        precioRegular: 120,
        accionPrecioOferta: 'ELIMINAR',
        moneda: 'PEN',
        motivoCambio: 'Corrección HTTP',
        priceVersion: 1,
        usuarioId: 'attacker',
      };
      const correlation = randomUUID();
      const patch = (value: object) =>
        request(app!.getHttpServer())
          .patch(path)
          .set('Authorization', 'Bearer ' + identity.token())
          .set('X-Correlation-Id', correlation)
          .send(value);
      const saved = await patch(body).expect(200);
      expect(saved.body).toMatchObject({
        product_id: productId,
        precio_regular: 120,
        precio_oferta: null,
        price_version: 2,
      });
      const definition = (await repository.findDefinition(
        { productId },
        null,
      ))!;
      const validities = await repository.findValidities(definition.id);
      expect(validities.find((v) => v.priceVersion === 2n)?.usuarioId).toBe(
        actor,
      );
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.correlationId, correlation)),
      ).toHaveLength(1);
      await patch(body).expect(409);
      await patch({
        ...body,
        priceVersion: 2,
        motivoCambio: 'fixture-fact-failure',
      }).expect(500);
      expect(
        (await repository.findDefinition({ productId }, null))!.priceVersion,
      ).toBe(2n);
      expect(await repository.findValidities(definition.id)).toHaveLength(2);
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.correlationId, correlation)),
      ).toHaveLength(1);
      denyWrite = true;
      try {
        await patch({ ...body, priceVersion: 2 }).expect(403);
      } finally {
        denyWrite = false;
      }
      await request(app!.getHttpServer()).patch(path).send(body).expect(401);
      await request(app!.getHttpServer())
        .patch(path)
        .set(
          'Authorization',
          'Bearer ' + identity.token({ roles: ['COMPRADOR'] }),
        )
        .send(body)
        .expect(403);
    });

    it('HTTP programa sin versión cliente, conserva vigencia actual y no crea un override de otro canal', async () => {
      const sku = 'HTTP-WRITE-' + randomUUID();
      const productId = randomUUID();
      contexts.set(sku, {
        sku,
        productId,
        isVariant: true,
        active: true,
        eligible: true,
      });
      await repository.transaction(async (tx) => {
        const [definition] = await tx
          .insert(prices)
          .values({ sku })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(definition.id),
          validFrom: new Date(Date.now() - 60000),
        });
      });
      const path = `/api/v1/precios/skus/${sku}`;
      const jwt = 'Bearer ' + identity.token();
      const scheduled = await request(app!.getHttpServer())
        .post(path + '/programaciones')
        .set('Authorization', jwt)
        .send({
          tipoPrecio: 'REGULAR',
          importe: 150,
          moneda: 'PEN',
          motivoCambio: 'Temporada',
          validFrom: '2035-01-01T00:00:00Z',
        })
        .expect(201);
      expect(scheduled.body).toMatchObject({
        sku,
        tipoPrecio: 'REGULAR',
        importe: 150,
        estado: 'SCHEDULED',
        priceVersion: 2,
      });
      const current = await request(app!.getHttpServer())
        .get(path)
        .set('Authorization', jwt)
        .expect(200);
      expect(current.body).toMatchObject({
        precio_regular: 99.99,
        price_version: 2,
      });
      const historical = await request(app!.getHttpServer())
        .get(path + '?at=' + new Date().toISOString())
        .set('Authorization', jwt)
        .expect(200);
      expect(historical.body.price_version).toBe(1);
      const body = {
        precioRegular: 130,
        accionPrecioOferta: 'CONSERVAR',
        moneda: 'PEN',
        motivoCambio: 'Corrección',
        priceVersion: 2,
      };
      await request(app!.getHttpServer())
        .patch(path)
        .set('Authorization', jwt)
        .send({ ...body, channelId: randomUUID() })
        .expect(400);
      await request(app!.getHttpServer())
        .patch(path)
        .set('Authorization', jwt)
        .send({ ...body, channelId: 'RETAIL' })
        .expect(404)
        .expect(({ body: problem }) => {
          expect(problem.code).toBe('PRECIO_NO_ENCONTRADO');
        });
      const saved = await request(app!.getHttpServer())
        .patch(path)
        .set('Authorization', jwt)
        .send(body)
        .expect(200);
      expect(saved.body).toMatchObject({
        sku,
        origen: 'SKU_OVERRIDE',
        precio_regular: 130,
        price_version: 3,
      });
      expect(saved.body.vigencia_id).toMatch(/^[0-9a-f-]{36}$/i);
      const future = await request(app!.getHttpServer())
        .get(path + '?at=2035-06-01T00:00:00Z')
        .set('Authorization', jwt)
        .expect(200);
      expect(future.body).toMatchObject({
        precio_regular: 150,
        price_version: 2,
      });
    });

    it('HTTP devuelve precio base vigente real, contrato y correlación; no expone actor ni historial', async () => {
      const productId = randomUUID();
      const started = new Date(Date.now() - 60000);
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx
          .insert(priceValidities)
          .values({ ...snapshot(price.id), validFrom: started });
      });
      const correlation = randomUUID();
      const response = await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${productId}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .set('X-Correlation-Id', correlation)
        .expect(200);
      expect(response.headers['x-correlation-id']).toBe(correlation);
      expect(response.body).toEqual({
        product_id: productId,
        precio_regular: 99.99,
        precio_oferta: 80.25,
        currency: 'PEN',
        channel_id: null,
        valid_from: started.toISOString(),
        valid_until: null,
        price_version: 1,
      });
      expect(response.text).not.toContain('fixture-actor');
      const unknown = await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${randomUUID()}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(404);
      expect(unknown.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(unknown.body).toMatchObject({
        status: 404,
        code: 'PRECIO_NO_ENCONTRADO',
      });
    });

    it('HTTP pagina programaciones propias por producto/SKU y deriva estados sin escribir', async () => {
      const productId = randomUUID();
      const sku = `0000-${randomUUID()}`;
      const now = Date.now();
      const future = new Date(now + 3600000);
      await repository.transaction(async (tx) => {
        for (const target of [{ productId }, { sku }]) {
          const [price] = await tx
            .insert(prices)
            .values({ ...target, priceVersion: 2n })
            .returning();
          const [past] = await tx
            .insert(priceValidities)
            .values({
              ...snapshot(price.id),
              validFrom: new Date(now - 3600000),
              validUntil: future,
            })
            .returning();
          const [later] = await tx
            .insert(priceValidities)
            .values({ ...snapshot(price.id, 2n), validFrom: future })
            .returning();
          await tx.insert(scheduledPrices).values([
            {
              priceId: price.id,
              validityId: past.id,
              tipoPrecio: 'REGULAR',
              importe: '99.99',
            },
            {
              priceId: price.id,
              validityId: later.id,
              tipoPrecio: 'REGULAR',
              importe: '99.99',
            },
          ]);
        }
      });
      for (const path of [`productos/${productId}`, `skus/${sku}`]) {
        const response = await request(app!.getHttpServer())
          .get(`/api/v1/precios/${path}/programaciones?pagina=1&tamanio=1`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(200);
        expect(response.body.meta).toEqual({
          pagina: 1,
          tamanio: 1,
          total: 2,
          totalPaginas: 2,
        });
        expect(response.body.items[0]).toMatchObject({
          estado: 'ACTIVE',
          importe: 99.99,
          moneda: 'PEN',
          priceVersion: 1,
        });
        const next = await request(app!.getHttpServer())
          .get(`/api/v1/precios/${path}/programaciones?pagina=2&tamanio=1`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(200);
        expect(next.body.items[0]).toMatchObject({
          estado: 'SCHEDULED',
          priceVersion: 2,
        });
      }
    });

    it('precio base pagina y cuenta solo programaciones globales; SKU conserva sus canales', async () => {
      const productId = randomUUID();
      const sku = 'channel-' + randomUUID();
      await repository.transaction(async (tx) => {
        for (const target of [{ productId }, { sku }]) {
          for (const channelId of [null, 'MARKETPLACE', 'RETAIL']) {
            const [price] = await tx
              .insert(prices)
              .values({ ...target, channelId, priceVersion: 2n })
              .returning();
            for (const version of [1n, 2n]) {
              const [validity] = await tx
                .insert(priceValidities)
                .values({
                  ...snapshot(price.id, version),
                  validFrom: version === 1n ? from : boundary,
                  validUntil: version === 1n ? boundary : null,
                })
                .returning();
              await tx.insert(scheduledPrices).values({
                priceId: price.id,
                validityId: validity.id,
                tipoPrecio: 'REGULAR',
                importe: '99.99',
              });
            }
          }
        }
      });
      for (const pagina of [1, 2]) {
        const result = await request(app!.getHttpServer())
          .get(
            `/api/v1/precios/productos/${productId}/programaciones?pagina=${pagina}&tamanio=1`,
          )
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(200);
        expect(result.body.meta).toEqual({
          pagina,
          tamanio: 1,
          total: 2,
          totalPaginas: 2,
        });
        expect(result.body.items).toHaveLength(1);
        expect(result.body.items[0]).toMatchObject({
          product_id: productId,
          channelId: null,
          priceVersion: pagina,
        });
      }
      const skuResult = await request(app!.getHttpServer())
        .get(`/api/v1/precios/skus/${sku}/programaciones?tamanio=1`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(skuResult.body.meta).toEqual({
        pagina: 1,
        tamanio: 1,
        total: 6,
        totalPaginas: 6,
      });
      const skuAll = await request(app!.getHttpServer())
        .get(`/api/v1/precios/skus/${sku}/programaciones`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(
        skuAll.body.items.map(
          (item: { channelId: string | null }) => item.channelId,
        ),
      ).toEqual(expect.arrayContaining([null, 'MARKETPLACE', 'RETAIL']));
    });

    it('precio base devuelve 404 si solo hay definición por canal y 200 vacío si existe global', async () => {
      const productId = randomUUID();
      await repository.transaction(async (tx) => {
        const { definition, validity } = await create(
          tx,
          { productId },
          'RETAIL',
        );
        await tx.insert(scheduledPrices).values({
          priceId: definition.id,
          validityId: validity.id,
          tipoPrecio: 'REGULAR',
          importe: '99.99',
        });
      });
      const path = `/api/v1/precios/productos/${productId}/programaciones`;
      const missing = await request(app!.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(404);
      expect(missing.body.code).toBe('PRECIO_NO_ENCONTRADO');
      await repository.transaction((tx) => create(tx, { productId }));
      const empty = await request(app!.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(empty.body).toEqual({
        items: [],
        meta: { pagina: 1, tamanio: 20, total: 0, totalPaginas: 0 },
      });
    });

    it.each(['productos', 'skus'])(
      'HTTP %s distingue definición inexistente de ausencia de programaciones',
      async (kind) => {
        const key = randomUUID();
        const path = `/api/v1/precios/${kind}/${key}/programaciones`;
        const missing = await request(app!.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(404);
        expect(missing.body).toMatchObject({
          status: 404,
          code: 'PRECIO_NO_ENCONTRADO',
        });
        expect(missing.headers['content-type']).toContain(
          'application/problem+json',
        );
        await repository.transaction(async (tx) => {
          const [price] = await tx
            .insert(prices)
            .values(kind === 'productos' ? { productId: key } : { sku: key })
            .returning();
          await tx.insert(priceValidities).values(snapshot(price.id));
        });
        const empty = await request(app!.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(200);
        expect(empty.body).toEqual({
          items: [],
          meta: { pagina: 1, tamanio: 20, total: 0, totalPaginas: 0 },
        });
      },
    );

    it('demo explícita permite consultas sin Authorization/G7 y readiness sigue dependiendo de PostgreSQL', async () => {
      const { definition } = await repository.transaction(async (tx) => {
        const [definition] = await tx
          .insert(prices)
          .values({ productId: randomUUID() })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(definition.id),
          validFrom: new Date(Date.now() - 60000),
        });
        return { definition };
      });
      const module = await Test.createTestingModule({
        imports: [
          PricingSvcModule.forRoot({
            NODE_ENV: 'test',
            PRICING_SVC_PORT: '3002',
            DATABASE_URL: postgres.runtimeUrl,
            PGSSLMODE: 'disable',
            GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
          }),
        ],
      }).compile();
      const demoApp = module.createNestApplication();
      const remote = vi.spyOn(globalThis, 'fetch');
      try {
        await demoApp.init();
        const path = `/api/v1/precios/productos/${definition.productId}`;
        await request(app!.getHttpServer()).get(path).expect(401);
        const result = await request(demoApp.getHttpServer())
          .get(path)
          .expect(200);
        expect(result.body).toMatchObject({
          product_id: definition.productId,
          precio_regular: 99.99,
        });
        await request(demoApp.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer unused-invalid-token')
          .expect(200);
        await request(demoApp.getHttpServer())
          .get(`${path}/programaciones`)
          .expect(200);
        await request(demoApp.getHttpServer())
          .get(path)
          .set('X-Correlation-Id', 'invalid')
          .expect(400);
        await request(demoApp.getHttpServer()).get('/health/ready').expect(200);
        expect(remote).not.toHaveBeenCalled();
        await postgres.admin!.query(
          'REVOKE SELECT ON pricing.prices FROM pricing_app',
        );
        try {
          await request(demoApp.getHttpServer())
            .get('/health/live')
            .expect(200);
          await request(demoApp.getHttpServer())
            .get('/health/ready')
            .expect(503);
          const failed = await request(demoApp.getHttpServer())
            .get(path)
            .expect(503);
          expect(failed.body.code).toBe('SERVICIO_NO_DISPONIBLE');
        } finally {
          await postgres.admin!.query(
            'GRANT SELECT ON pricing.prices TO pricing_app',
          );
        }
        await request(demoApp.getHttpServer()).get('/health/ready').expect(200);
        await request(app!.getHttpServer()).get(path).expect(401);
      } finally {
        remote.mockRestore();
        await demoApp.close();
      }
    });

    it('HTTP consulta un lote persistido sin filtrar row_input, report_uri ni detalle libre', async () => {
      const job = await repository.transaction(async (tx) => {
        const [job] = await tx
          .insert(bulkPriceJobs)
          .values({
            allowPartial: false,
            totalRows: 1,
            correlationId: randomUUID(),
            usuarioId: 'fixture-sensitive-actor',
            reportUri: 'https://private.invalid/secret',
          })
          .returning();
        await tx.insert(bulkPriceRows).values({
          batchId: job.id,
          rowId: '1',
          sku: '0001',
          rowInput: { secret: 'fixture-sensitive-input' },
          detail: 'fixture-sensitive-detail',
        });
        return job;
      });
      const response = await request(app!.getHttpServer())
        .get(`/api/v1/precios/importaciones/${job.id}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(response.body).toEqual({
        batch_id: job.id,
        status: 'QUEUED',
        allow_partial: false,
        total_rows: 1,
        completed_rows: 0,
        failed_rows: 0,
        rows: [{ row_id: '1', sku: '0001', status: 'PENDING' }],
      });
      expect(response.text).not.toMatch(/fixture-sensitive|private.invalid/);
      const selected = await repository.readImport(job.id);
      expect(Object.keys(selected!.rows![0]).sort()).toEqual([
        'code',
        'rowId',
        'sku',
        'status',
      ]);
      const absent = await request(app!.getHttpServer())
        .get(`/api/v1/precios/importaciones/${randomUUID()}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(404);
      expect(absent.body.code).toBe('LOTE_NO_ENCONTRADO');
    });

    it('importaciones grandes devuelven resumen contractual y jamás detalle truncado', async () => {
      const job = await repository.transaction(async (tx) => {
        const [job] = await tx
          .insert(bulkPriceJobs)
          .values({
            allowPartial: false,
            totalRows: MAX_INLINE_IMPORT_ROWS + 1,
            correlationId: randomUUID(),
          })
          .returning();
        await tx.execute(sql`INSERT INTO pricing.bulk_price_rows (batch_id,row_id,sku,row_input)
          SELECT ${job.id}::uuid, value::text, 'SKU-' || value, jsonb_build_object('private',repeat('x',1024))
          FROM generate_series(1,${MAX_INLINE_IMPORT_ROWS}) AS value`);
        return job;
      });
      const boundary = await repository.readImport(job.id);
      expect(boundary!.rows).toHaveLength(MAX_INLINE_IMPORT_ROWS);
      await repository.transaction((tx) =>
        tx
          .insert(bulkPriceRows)
          .values({ batchId: job.id, rowId: 'extra', rowInput: {} }),
      );
      const result = await repository.readImport(job.id);
      expect(result!.rows).toBeUndefined();
      const response = await request(app!.getHttpServer())
        .get(`/api/v1/precios/importaciones/${job.id}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(response.body).toEqual({
        batch_id: job.id,
        status: 'QUEUED',
        allow_partial: false,
        total_rows: MAX_INLINE_IMPORT_ROWS + 1,
        completed_rows: 0,
        failed_rows: 0,
      });
    });

    it('HTTP niega acceso y parámetros inválidos antes de consultar datos', async () => {
      const path = `/api/v1/precios/productos/${randomUUID()}/programaciones`;
      await request(app!.getHttpServer()).get(path).expect(401);
      const forbidden = await request(app!.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${identity.token({ roles: ['OTRO'] })}`)
        .expect(403);
      expect(forbidden.body.code).toBe('SCOPE_INSUFICIENTE');
      for (const query of [
        'pagina=0',
        'pagina=1e2',
        'tamanio=201',
        'pagina=1&pagina=2',
        'canal=RETAIL',
        'pagina=9999999999999999999',
      ]) {
        const response = await request(app!.getHttpServer())
          .get(`${path}?${query}`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(400);
        expect(response.body.code).toBe('VALIDACION');
      }
      await request(app!.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${identity.token()}`)
        .set('X-Correlation-Id', 'secret-not-uuid')
        .expect(400);
      await request(app!.getHttpServer())
        .get('/api/v1/precios/importaciones/not-uuid')
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(400);
    });

    it('#56: crea definición ausente solo con versión cero y conserva CAS al actualizar', async () => {
      const productId = randomUUID();
      const body = {
        priceVersion: 0,
        precioRegular: 100,
        precioOferta: null,
        accionPrecioOferta: 'CONSERVAR',
        moneda: 'PEN',
        motivoCambio: 'Alta precio base',
      };
      await request(app!.getHttpServer())
        .patch(`/api/v1/precios/productos/${productId}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .send(body)
        .expect(200)
        .expect(({ body: result }) => {
          expect(result).toMatchObject({
            product_id: productId,
            price_version: 1,
          });
        });
      await request(app!.getHttpServer())
        .patch(`/api/v1/precios/productos/${productId}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .send({ ...body, precioRegular: 101 })
        .expect(409)
        .expect(({ body: result }) => {
          expect(result.code).toBe('VERSION_CONFLICT');
        });
      await request(app!.getHttpServer())
        .patch(`/api/v1/precios/productos/${productId}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .send({ ...body, priceVersion: 1, precioRegular: 110 })
        .expect(200)
        .expect(({ body: result }) => {
          expect(result.price_version).toBe(2);
        });
      expect(
        (await repository.findDefinition({ productId }, null))?.priceVersion,
      ).toBe(2n);

      const sku = `VAR-${randomUUID()}`;
      contexts.set(sku, {
        sku,
        productId,
        isVariant: true,
        active: true,
        eligible: true,
      });
      await request(app!.getHttpServer())
        .patch(`/api/v1/precios/skus/${encodeURIComponent(sku)}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .send({ ...body, precioRegular: 80, motivoCambio: 'Override inicial' })
        .expect(200)
        .expect(({ body: result }) => {
          expect(result).toMatchObject({
            sku,
            origen: 'SKU_OVERRIDE',
            price_version: 1,
          });
        });
      expect(
        (await repository.findDefinition({ sku }, null))?.priceVersion,
      ).toBe(1n);
    });

    it('#56: el caso de uso real serializa escritores y revierte precio/historia si falla Outbox', async () => {
      const productId = randomUUID();
      const now = new Date();
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(price.id),
          validFrom: new Date(now.getTime() - 60000),
        });
      });
      const fact = {
        messageId: randomUUID(),
        correlationId: randomUUID(),
        payload: {},
      };
      const input = {
        precioRegular: '120.00',
        accionPrecioOferta: 'CONSERVAR' as const,
        currency: 'PEN',
        motivoCambio: 'fixture-change',
        usuarioId: actor,
      };
      const results = await Promise.allSettled([
        mutations.update({ productId }, null, input, 1n, now, fact),
        mutations.update({ productId }, null, input, 1n, now, {
          ...fact,
          messageId: randomUUID(),
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
      const definition = (await repository.findDefinition(
        { productId },
        null,
      ))!;
      expect(definition.priceVersion).toBe(2n);
      expect(await repository.findValidities(definition.id)).toHaveLength(2);
      const committedFacts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, fact.correlationId));
      expect(committedFacts).toHaveLength(1);
      await expect(
        mutations.update(
          { productId },
          null,
          input,
          2n,
          new Date(now.getTime() + 1000),
          { ...fact, messageId: committedFacts[0].messageId },
        ),
      ).rejects.toMatchObject({ sqlState: '23505' });
      expect(
        (await repository.findDefinition({ productId }, null))!.priceVersion,
      ).toBe(2n);
      expect(await repository.findValidities(definition.id)).toHaveLength(2);
      const facts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, fact.correlationId));
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        eventName: 'pricing.price.changed',
        publishedAt: null,
      });
    });

    it('#56: programa bajo lock sin versión cliente y conserva precio vigente hasta el inicio', async () => {
      const productId = randomUUID();
      const now = new Date();
      const future = new Date(now.getTime() + 3600000);
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(price.id),
          validFrom: new Date(now.getTime() - 60000),
        });
      });
      const input = {
        tipoPrecio: 'OFERTA' as const,
        importe: '70.00',
        currency: 'PEN',
        motivoCambio: 'fixture-schedule',
        usuarioId: 'fixture-actor',
        validFrom: future,
        validUntil: null,
      };
      const fact = () => ({
        messageId: randomUUID(),
        correlationId: randomUUID(),
        payload: {},
      });
      const correlationId = randomUUID();
      await mutations.schedule({ productId }, null, input, now, fact(), {
        productId,
        correlationId,
      });
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.correlationId, correlationId)),
      ).toHaveLength(0);
      const definition = (await repository.findDefinition(
        { productId },
        null,
      ))!;
      expect(definition.priceVersion).toBe(2n);
      const validities = await repository.findValidities(definition.id);
      expect(validities.map((value) => value.validUntil)).toEqual([
        future,
        null,
      ]);
      expect(
        await repository.readSchedules({ productId }, 1, 20),
      ).toMatchObject({ total: 1 });
      expect(await reconciler.runOnce(future)).toEqual({
        activated: 1,
        historical: 2,
      });
      const effectiveFacts = await database.db
        .select()
        .from(outbox)
        .where(eq(outbox.correlationId, correlationId));
      expect(effectiveFacts).toHaveLength(1);
      expect(effectiveFacts[0].payload).toMatchObject({
        target_type: 'PRODUCTO',
        product_id: productId,
        price_type: 'OFERTA',
        previous_price: '80.25',
        new_price: '70.00',
        price_version: 2,
      });
      const current = await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${productId}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(200);
      expect(current.body).toMatchObject({
        precio_oferta: 80.25,
        price_version: 2,
      });
      await expect(
        mutations.schedule(
          { productId },
          null,
          {
            ...input,
            validFrom: new Date(future.getTime() - 1000),
            validUntil: new Date(future.getTime() + 1000),
          },
          now,
          fact(),
        ),
      ).rejects.toMatchObject({ code: 'VIGENCIA_SUPERPUESTA' });
      expect(
        (await repository.findDefinition({ productId }, null))!.priceVersion,
      ).toBe(2n);
    });

    it('marca histórica una programación ya vencida sin emitirla retroactivamente', async () => {
      const productId = randomUUID();
      const now = new Date();
      const future = new Date(now.getTime() + 1000);
      const expires = new Date(now.getTime() + 2000);
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          ...snapshot(price.id),
          validFrom: new Date(now.getTime() - 60000),
        });
      });
      const correlationId = randomUUID();
      await mutations.schedule(
        { productId },
        null,
        {
          tipoPrecio: 'OFERTA',
          importe: '70.00',
          currency: 'PEN',
          motivoCambio: 'fixture-expired-schedule',
          usuarioId: actor,
          validFrom: future,
          validUntil: expires,
        },
        now,
        undefined,
        { productId, correlationId },
      );
      expect(await reconciler.runOnce(new Date(expires.getTime() + 1))).toEqual(
        {
          activated: 0,
          historical: 1,
        },
      );
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.correlationId, correlationId)),
      ).toHaveLength(0);
      expect(
        await repository.readSchedules({ productId }, 1, 20),
      ).toMatchObject({ items: [{ schedule: { status: 'HISTORICAL' } }] });
    });

    it('activa una vencida válida detrás de más de 25 registros incompatibles y emite el hecho una sola vez', async () => {
      const now = new Date('2036-01-01T00:00:00Z');
      const ids: string[] = [];
      await repository.transaction(async (tx) => {
        for (let index = 0; index < 26; index++) {
          const target = await create(tx, {
            productId: `legacy-${randomUUID()}`,
          });
          const validFrom = new Date(now.getTime() - (3600000 + index));
          await tx
            .update(priceValidities)
            .set({ validFrom })
            .where(eq(priceValidities.id, target.validity.id));
          const [schedule] = await tx
            .insert(scheduledPrices)
            .values({
              priceId: target.definition.id,
              validityId: target.validity.id,
              productId: null,
              correlationId: null,
              tipoPrecio: 'REGULAR',
              importe: '99.99',
              status: 'SCHEDULED',
            })
            .returning();
          ids.push(schedule.id);
        }
      });
      const productId = randomUUID();
      const future = new Date(now.getTime() - 1000);
      await repository.transaction(async (tx) => {
        const [price] = await tx
          .insert(prices)
          .values({ productId })
          .returning();
        await tx.insert(priceValidities).values({
          priceId: price.id,
          precioRegular: '99.99',
          precioOferta: null,
          currency: 'PEN',
          validFrom: new Date(now.getTime() - 60000),
          validUntil: null,
          priceVersion: 1n,
          motivoCambio: 'antes',
          usuarioId: actor,
        });
      });
      const correlationId = randomUUID();
      const result = await mutations.schedule(
        { productId },
        null,
        {
          tipoPrecio: 'OFERTA',
          importe: '70.00',
          currency: 'PEN',
          motivoCambio: 'válida vencida',
          usuarioId: actor,
          validFrom: future,
          validUntil: null,
        },
        new Date(now.getTime() - 30000),
        undefined,
        { productId, correlationId },
      );
      const scheduleId = result.scheduled.id;
      expect((await reconciler.runOnce(now)).activated).toBeGreaterThanOrEqual(
        1,
      );
      await reconciler.runOnce(now);
      expect(
        await database.db
          .select()
          .from(scheduledPrices)
          .where(eq(scheduledPrices.id, scheduleId)),
      ).toMatchObject([{ status: 'ACTIVE' }]);
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.correlationId, correlationId)),
      ).toHaveLength(1);
      expect(
        await database.db
          .select()
          .from(scheduledPrices)
          .where(inArray(scheduledPrices.id, ids)),
      ).toHaveLength(26);
    });

    it('HTTP no confunde falta de permisos DB con precio ausente y se recupera', async () => {
      await postgres.admin!.query(
        'REVOKE SELECT ON pricing.prices FROM pricing_app',
      );
      try {
        const response = await request(app!.getHttpServer())
          .get(`/api/v1/precios/productos/${randomUUID()}`)
          .set('Authorization', `Bearer ${identity.token()}`)
          .expect(503);
        expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
        expect(response.text).not.toMatch(
          /SELECT|permission|pricing_app|postgresql/,
        );
      } finally {
        await postgres.admin!.query(
          'GRANT SELECT ON pricing.prices TO pricing_app',
        );
      }
      await request(app!.getHttpServer())
        .get(`/api/v1/precios/productos/${randomUUID()}`)
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(404);
    });

    it('el mapping coincide con todas las columnas reales, nullabilidad y tipos', async () => {
      const { rows } = await postgres.admin!.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        udt_name: string;
        numeric_precision: number;
        numeric_scale: number;
      }>(
        "SELECT * FROM information_schema.columns WHERE table_schema = 'pricing'",
      );
      for (const table of Object.values(pricingSchema)) {
        const config = getTableConfig(table);
        const actual = rows.filter((row) => row.table_name === config.name);
        expect(actual.map((row) => row.column_name).sort()).toEqual(
          config.columns.map((col) => col.name).sort(),
        );
        for (const col of config.columns) {
          const real = actual.find((row) => row.column_name === col.name)!;
          expect(real.is_nullable).toBe(col.notNull ? 'NO' : 'YES');
          const typeNames: Record<string, string> = {
            bigint: 'int8',
            integer: 'int4',
            boolean: 'bool',
            'char(3)': 'bpchar',
            'timestamp with time zone': 'timestamptz',
            'numeric(12,2)': 'numeric',
          };
          expect(real.udt_name).toBe(
            typeNames[col.getSQLType()] ?? col.getSQLType(),
          );
          if (col.getSQLType() === 'numeric(12,2)') {
            expect(real).toMatchObject({
              udt_name: 'numeric',
              numeric_precision: 12,
              numeric_scale: 2,
            });
          }
        }
      }
      const { rows: foreignKeys } = await postgres.admin!.query<{
        schema: string;
      }>(
        `SELECT n.nspname AS schema FROM pg_constraint c JOIN pg_class t ON t.oid=c.confrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f' AND c.connamespace='pricing'::regnamespace`,
      );
      expect(foreignKeys).toHaveLength(3);
      expect(foreignKeys.every((fk) => fk.schema === 'pricing')).toBe(true);
    });

    it('inyecta provider/repositorio reales y comparte el pool con readiness', async () => {
      expect(await database.check()).toBe(true);
      await request(app!.getHttpServer()).get('/health/ready').expect(200);
      const { definition, validity } = await repository.transaction(
        async (tx) => {
          const result = await create(tx);
          await tx.insert(outbox).values(event());
          return result;
        },
      );
      expect(
        await repository.findDefinition(
          { productId: definition.productId! },
          null,
        ),
      ).toEqual(definition);
      expect(await repository.findValidities(definition.id)).toEqual([
        validity,
      ]);
      expect(validity).toMatchObject({
        precioRegular: '99.99',
        precioOferta: '80.25',
        priceVersion: 1n,
        validFrom: from,
      });
    });

    it('distingue producto/SKU y canal específico/global sin consultar Catálogo', async () => {
      const productId = randomUUID();
      await repository.transaction((tx) => create(tx, { productId }));
      await repository.transaction((tx) => create(tx, { productId }, 'WEB'));
      await repository.transaction(async (tx) => {
        const [p] = await tx
          .insert(prices)
          .values({ sku: productId })
          .returning();
        await tx.insert(priceValidities).values(snapshot(p.id));
      });
      const global = await repository.findDefinition({ productId }, null);
      const specific = await repository.findDefinition({ productId }, 'WEB');
      const sku = await repository.findDefinition({ sku: productId }, null);
      expect(new Set([global!.id, specific!.id, sku!.id]).size).toBe(3);
      await expect(
        repository.transaction((tx) => create(tx, { productId })),
      ).rejects.toMatchObject({ sqlState: '23505' });
    });

    it('revierte definición, snapshot, Inbox y Outbox juntos si falla el callback', async () => {
      const productId = randomUUID();
      const messageId = randomUUID();
      const rejection = new Error('rechazo intencional');
      await expect(
        repository.transaction(async (tx) => {
          await create(tx, { productId });
          await tx.insert(outbox).values({ ...event(), messageId });
          await tx.insert(inbox).values({
            messageId,
            handler: 'fixture',
            eventName: 'pricing.product.initialization.requested',
            payload: {},
            result: 'fixture',
          });
          throw rejection;
        }),
      ).rejects.toBe(rejection);
      expect(
        await repository.findDefinition({ productId }, null),
      ).toBeUndefined();
      for (const table of [outbox, inbox]) {
        expect(
          await database.db
            .select()
            .from(table)
            .where(eq(table.messageId, messageId)),
        ).toHaveLength(0);
      }
    });

    it('rechaza readiness en esquema 0001 y permite aplicar 0002 repetidamente sin cambios incoherentes', async () => {
      const migration = await readFile(
        new URL(
          '../migrations/0002_schedule_effective_events.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const baseline = await postgres.admin!.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='pricing' AND table_name='scheduled_prices'
          AND column_name IN ('product_id','correlation_id')
      `);
      expect(baseline.rows.map((row) => row.column_name).sort()).toEqual([
        'correlation_id',
        'product_id',
      ]);
      await postgres.admin!.query(
        'ALTER TABLE pricing.scheduled_prices DROP COLUMN product_id, DROP COLUMN correlation_id',
      );
      expect(await database.check()).toBe(false);
      await postgres.admin!.query('BEGIN');
      try {
        await postgres.admin!.query(migration);
        await postgres.admin!.query(migration);
        await postgres.admin!.query('COMMIT');
      } catch (error) {
        await postgres.admin!.query('ROLLBACK');
        throw error;
      }
      expect(await database.check()).toBe(true);
      const columns = await postgres.admin!.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='pricing' AND table_name='scheduled_prices'
          AND column_name IN ('product_id','correlation_id')
      `);
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
        'correlation_id',
        'product_id',
      ]);
    });

    it('restricciones diferidas fallan en COMMIT y revierten también Outbox', async () => {
      const productId = randomUUID();
      const messageId = randomUUID();
      await expect(
        repository.transaction(async (tx) => {
          await tx.insert(prices).values({ productId });
          await tx.insert(outbox).values({ ...event(), messageId });
        }),
      ).rejects.toMatchObject({ sqlState: '23514' });
      expect(
        await repository.findDefinition({ productId }, null),
      ).toBeUndefined();
      expect(
        await database.db
          .select()
          .from(outbox)
          .where(eq(outbox.messageId, messageId)),
      ).toHaveLength(0);
    });

    it('enforce FK internas simples y compuestas', async () => {
      await expect(
        repository.transaction((tx) =>
          tx.insert(priceValidities).values(snapshot(randomUUID())),
        ),
      ).rejects.toMatchObject({ sqlState: '23503' });
      const a = await repository.transaction((tx) => create(tx));
      const b = await repository.transaction((tx) => create(tx));
      await expect(
        repository.transaction((tx) =>
          tx.insert(scheduledPrices).values({
            priceId: a.definition.id,
            validityId: b.validity.id,
            tipoPrecio: 'REGULAR',
            importe: '99.99',
          }),
        ),
      ).rejects.toMatchObject({ sqlState: '23503' });
    });

    it('protege dinero, XOR del objetivo e intervalos en PostgreSQL', async () => {
      await expect(
        repository.transaction((tx) =>
          tx.insert(prices).values({ productId: 'P', sku: 'S' }),
        ),
      ).rejects.toMatchObject({ sqlState: '23514' });
      for (const invalid of [
        { precioRegular: '0' },
        { precioOferta: '99.99' },
        { validUntil: from },
      ]) {
        await expect(
          repository.transaction(async (tx) => {
            const [p] = await tx
              .insert(prices)
              .values({ sku: randomUUID() })
              .returning();
            await tx
              .insert(priceValidities)
              .values({ ...snapshot(p.id), ...invalid });
          }),
        ).rejects.toMatchObject({ sqlState: '23514' });
      }
      await expect(
        repository.transaction(async (tx) => {
          const [p] = await tx
            .insert(prices)
            .values({ sku: randomUUID() })
            .returning();
          await tx
            .insert(priceValidities)
            .values({ ...snapshot(p.id), precioRegular: '1.001' });
        }),
      ).rejects.toThrow('precisión');
    });

    it('rechaza solapamiento y admite intervalos contiguos con versión CAS', async () => {
      const { definition, validity } = await repository.transaction((tx) =>
        create(tx),
      );
      await expect(
        repository.transaction(async (tx) => {
          await tx
            .update(prices)
            .set({ priceVersion: 2n })
            .where(eq(prices.id, definition.id));
          await tx
            .insert(priceValidities)
            .values({ ...snapshot(definition.id, 2n), validFrom: boundary });
        }),
      ).rejects.toMatchObject({ sqlState: '23P01' });
      await repository.transaction(async (tx) => {
        await tx
          .update(prices)
          .set({ priceVersion: 2n })
          .where(
            and(eq(prices.id, definition.id), eq(prices.priceVersion, 1n)),
          );
        await tx
          .update(priceValidities)
          .set({ validUntil: boundary })
          .where(eq(priceValidities.id, validity.id));
        await tx
          .insert(priceValidities)
          .values({ ...snapshot(definition.id, 2n), validFrom: boundary });
        await tx.insert(outbox).values(event());
      });
      expect(await repository.findValidities(definition.id)).toHaveLength(2);
      const stale = await repository.transaction((tx) =>
        tx
          .update(prices)
          .set({ priceVersion: 2n })
          .where(and(eq(prices.id, definition.id), eq(prices.priceVersion, 1n)))
          .returning(),
      );
      expect(stale).toHaveLength(0);
    });

    it('CAS concurrente admite un solo escritor y un solo Outbox', async () => {
      const { definition, validity } = await repository.transaction((tx) =>
        create(tx),
      );
      const messages = [event(), event()];
      const results = await Promise.all(
        messages.map((message) =>
          repository.transaction(async (tx) => {
            const changed = await tx
              .update(prices)
              .set({ priceVersion: 2n })
              .where(
                and(eq(prices.id, definition.id), eq(prices.priceVersion, 1n)),
              )
              .returning();
            if (!changed.length) return false;
            await tx
              .update(priceValidities)
              .set({ validUntil: boundary })
              .where(eq(priceValidities.id, validity.id));
            await tx
              .insert(priceValidities)
              .values({ ...snapshot(definition.id, 2n), validFrom: boundary });
            await tx.insert(outbox).values(message);
            return true;
          }),
        ),
      );
      expect(results.sort()).toEqual([false, true]);
      const rows = await database.db.select().from(outbox);
      expect(
        rows.filter((row) =>
          messages.some((message) => message.messageId === row.messageId),
        ),
      ).toHaveLength(1);
    });

    it('persiste programación coherente y lote local con filas durables', async () => {
      const { definition, validity } = await repository.transaction((tx) =>
        create(tx),
      );
      const [scheduled] = await repository.transaction((tx) =>
        tx
          .insert(scheduledPrices)
          .values({
            priceId: definition.id,
            validityId: validity.id,
            tipoPrecio: 'OFERTA',
            importe: '80.25',
          })
          .returning(),
      );
      expect(scheduled.status).toBe('SCHEDULED');
      await expect(
        repository.transaction((tx) =>
          tx
            .update(scheduledPrices)
            .set({ importe: '80.24' })
            .where(eq(scheduledPrices.id, scheduled.id)),
        ),
      ).rejects.toMatchObject({ sqlState: '23514' });
      const [job] = await repository.transaction((tx) =>
        tx
          .insert(bulkPriceJobs)
          .values({
            allowPartial: true,
            totalRows: 1,
            correlationId: randomUUID(),
          })
          .returning(),
      );
      const [row] = await repository.transaction((tx) =>
        tx
          .insert(bulkPriceRows)
          .values({ batchId: job.id, rowId: '1', rowInput: { sku: 'fixture' } })
          .returning(),
      );
      expect(row).toMatchObject({
        status: 'PENDING',
        rowInput: { sku: 'fixture' },
      });
      await expect(
        repository.transaction((tx) =>
          tx
            .insert(bulkPriceRows)
            .values({ batchId: job.id, rowId: '1', rowInput: {} }),
        ),
      ).rejects.toMatchObject({ sqlState: '23505' });
      await expect(
        repository.transaction((tx) =>
          tx
            .update(bulkPriceJobs)
            .set({ status: 'COMPLETED' })
            .where(eq(bulkPriceJobs.id, job.id)),
        ),
      ).rejects.toMatchObject({ sqlState: '23514' });
      await repository.transaction(async (tx) => {
        await tx
          .update(bulkPriceRows)
          .set({ status: 'COMPLETED' })
          .where(eq(bulkPriceRows.id, row.id));
        await tx
          .update(bulkPriceJobs)
          .set({ status: 'COMPLETED', completedRows: 1 })
          .where(eq(bulkPriceJobs.id, job.id));
      });
    });

    it('Inbox deduplica por mensaje/handler y Outbox por mensaje', async () => {
      const message = event();
      const received = {
        messageId: message.messageId,
        handler: 'fixture',
        eventName: 'pricing.product.initialization.requested',
        payload: {},
        result: 'fixture',
      };
      await repository.transaction(async (tx) => {
        await tx.insert(inbox).values(received);
        await tx.insert(outbox).values(message);
      });
      await expect(
        repository.transaction((tx) => tx.insert(inbox).values(received)),
      ).rejects.toMatchObject({ sqlState: '23505' });
      await expect(
        repository.transaction((tx) => tx.insert(outbox).values(message)),
      ).rejects.toMatchObject({ sqlState: '23505' });
      await repository.transaction((tx) =>
        tx.insert(inbox).values({ ...received, handler: 'otro' }),
      );
    });

    it('runtime sin ownership/DDL/DELETE/TRUNCATE ni acceso cross-schema', async () => {
      const privileges = await database.db.execute(sql`
        SELECT tablename AS name,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'SELECT') AS read,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'INSERT') AS insert,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'UPDATE') AS update,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'DELETE') AS delete,
          has_table_privilege(current_user, schemaname || '.' || tablename, 'TRUNCATE') AS truncate
        FROM pg_tables WHERE schemaname = 'pricing'`);
      expect(privileges.rows).toHaveLength(7);
      for (const row of privileges.rows) {
        expect(row).toEqual({
          name: row.name,
          read: true,
          insert: true,
          update: row.name !== 'inbox',
          delete: false,
          truncate: false,
        });
      }
      const result = await database.db.execute(sql`SELECT current_user AS role,
      pg_has_role(current_user, 'po_pricing_owner', 'MEMBER') AS owner,
      has_schema_privilege(current_user, 'pricing', 'CREATE') AS ddl`);
      expect(result.rows).toEqual([
        { role: 'pricing_app', owner: false, ddl: false },
      ]);
      for (const statement of [
        sql`DELETE FROM pricing.prices WHERE false`,
        sql`TRUNCATE pricing.prices`,
        sql`CREATE TABLE pricing.denied (id integer)`,
        sql`UPDATE pricing.inbox SET result = 'denied' WHERE false`,
        sql`SELECT * FROM foreign_fixture.secret`,
        sql`SET ROLE po_pricing_owner`,
      ]) {
        await expect(
          repository.transaction((tx) => tx.execute(statement)),
        ).rejects.toMatchObject({ sqlState: '42501' });
      }
      expect(await database.check()).toBe(true);
    });

    it('#54: planes de dominio persisten con CAS, histórico, programación y Outbox local', async () => {
      const productId = randomUUID();
      const initial = initializeProduct(
        {
          productId,
          skuBase: '000123',
          precioRegular: '100.00',
          currency: 'PEN',
          channelId: null,
          motivoCambio: 'ALTA_PRODUCTO',
        },
        from,
      ).definition;
      const priceId = await repository.transaction(async (tx) => {
        const [row] = await tx.insert(prices).values({ productId }).returning();
        await tx
          .insert(priceValidities)
          .values({ ...initial.validities[0], priceId: row.id });
        await tx.insert(outbox).values(event());
        return row.id;
      });
      async function persistPlan(plan: PriceDefinition, expected: bigint) {
        await repository.transaction(async (tx) => {
          const rows = await tx
            .update(prices)
            .set({ priceVersion: plan.priceVersion })
            .where(
              and(eq(prices.id, priceId), eq(prices.priceVersion, expected)),
            )
            .returning();
          if (rows.length !== 1) throw new Error('VERSION_CONFLICT');
          for (const validity of plan.validities) {
            if (validity.priceVersion === plan.priceVersion) {
              await tx.insert(priceValidities).values({ ...validity, priceId });
            } else {
              await tx
                .update(priceValidities)
                .set({ validUntil: validity.validUntil })
                .where(
                  and(
                    eq(priceValidities.priceId, priceId),
                    eq(priceValidities.priceVersion, validity.priceVersion),
                  ),
                );
            }
          }
          // Solo fixture de persistencia; no concreta el GenericData de producción.
          await tx.insert(outbox).values(event());
        });
      }
      const changed = changePrice(
        initial,
        {
          precioRegular: '120.00',
          accionPrecioOferta: 'CONSERVAR',
          currency: 'PEN',
          motivoCambio: 'fixture-update',
          usuarioId: 'fixture-actor',
        },
        1n,
        new Date('2030-02-01T00:00:00Z'),
      ).definition;
      await persistPlan(changed, 1n);
      const scheduled = schedulePrice(
        changed,
        {
          tipoPrecio: 'OFERTA',
          importe: '90.00',
          currency: 'PEN',
          motivoCambio: 'fixture-schedule',
          usuarioId: 'fixture-actor',
          validFrom: boundary,
          validUntil: null,
        },
        new Date('2030-03-01T00:00:00Z'),
      );
      await persistPlan(scheduled, 2n);
      const stored = await repository.findValidities(priceId);
      expect(stored.map((row) => row.priceVersion)).toEqual([1n, 2n, 3n]);
      expect(stored[0].validUntil).toEqual(changed.validities[0].validUntil);
      expect(stored[1].validUntil).toEqual(boundary);
      expect(stored[2]).toMatchObject({
        precioRegular: '120.00',
        precioOferta: '90.00',
        usuarioId: 'fixture-actor',
      });
      await expect(persistPlan(scheduled, 2n)).rejects.toThrow(
        'VERSION_CONFLICT',
      );
      expect(await repository.findValidities(priceId)).toHaveLength(3);
    });

    it('un error real DB queda sanitizado y el pool continúa operativo', async () => {
      const error = await repository
        .transaction((tx) =>
          tx.insert(priceValidities).values({
            ...snapshot(randomUUID()),
            motivoCambio: 'fixture-sensitive-value',
          }),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PricingPersistenceError);
      expect(error).toMatchObject({ sqlState: '23503' });
      expect(JSON.stringify(error)).not.toMatch(
        /fixture-sensitive-value|insert into|postgresql/,
      );
      expect(await database.check()).toBe(true);
    });
  },
);
