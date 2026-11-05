import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  changePrice,
  schedulePrice,
  requireRule,
  validateTerms,
  type PriceDefinition,
  type PriceUpdate,
} from '../domain/price.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import type { PricingTransaction } from '../persistence/pricing.database.js';
import {
  prices,
  priceValidities,
  scheduledPrices,
  outbox,
} from '../persistence/pricing.schema.js';

type Target =
  { productId: string; sku?: never } | { sku: string; productId?: never };
// GenericData lo suministra el adaptador cuando P-PRI-02 esté resuelto; sin payload por defecto.
export type PriceFact = Pick<
  typeof outbox.$inferInsert,
  'messageId' | 'correlationId' | 'causationId' | 'operationId' | 'payload'
>;
export type PriceFactSource =
  | PriceFact
  | readonly PriceFact[]
  | ((
      before: PriceDefinition,
      after: PriceDefinition,
    ) => PriceFact | readonly PriceFact[]);

@Injectable()
export class PricingMutations {
  constructor(
    @Inject(PricingRepository) private readonly repository: PricingRepository,
  ) {}

  update(
    target: Target,
    channelId: string | null,
    input: PriceUpdate,
    expectedVersion: bigint,
    now: Date,
    fact: PriceFactSource,
  ) {
    return this.repository.transaction(async (tx) => {
      await this.lockSkuAndRejectDeactivated(tx, target);
      const loaded = await this.loadMaybe(tx, target, channelId);
      if (!loaded) {
        requireRule(expectedVersion === 0n, 'PRECIO_NO_ENCONTRADO');
        const regular = input.precioRegular;
        requireRule(
          regular !== undefined && regular !== null,
          'PRECIO_INVALIDO',
        );
        const offer =
          input.accionPrecioOferta === 'ESTABLECER'
            ? (input.precioOferta ?? null)
            : null;
        const terms = {
          precioRegular: regular,
          precioOferta: offer,
          currency: input.currency,
          motivoCambio: input.motivoCambio,
          usuarioId: input.usuarioId,
        };
        validateTerms(terms);
        const targetDefinition = {
          productId: target.productId ?? null,
          sku: target.sku ?? null,
        };
        const definition: PriceDefinition = {
          target: targetDefinition as PriceDefinition['target'],
          channelId,
          priceVersion: 1n,
          validities: [
            {
              ...terms,
              validFrom: now,
              validUntil: null,
              priceVersion: 1n,
              isCancelled: false,
            },
          ],
        };
        const [row] = await tx
          .insert(prices)
          .values({
            productId: targetDefinition.productId,
            sku: targetDefinition.sku,
            channelId,
          })
          .onConflictDoNothing()
          .returning();
        requireRule(row !== undefined, 'VERSION_CONFLICT');
        const [stored] = await tx
          .insert(priceValidities)
          .values({ ...definition.validities[0], priceId: row.id })
          .returning();
        const before: PriceDefinition = {
          target: definition.target,
          channelId,
          priceVersion: 0n,
          validities: [],
        };
        const facts =
          typeof fact === 'function' ? fact(before, definition) : fact;
        const rows = Array.isArray(facts) ? facts : [facts];
        if (rows.length)
          await tx.insert(outbox).values(
            rows.map((item) => ({
              ...item,
              eventName: 'pricing.price.changed',
              kind: 'event' as const,
              schemaVersion: 1,
              occurredAt: now,
            })),
          );
        return {
          definition,
          validityId: stored.id,
          tipoOperacion: 'CREACION' as const,
        };
      }
      const { row, definition } = loaded;
      const result = changePrice(definition, input, expectedVersion, now);
      const stored = await this.persist(
        tx,
        row.id,
        result.definition,
        expectedVersion,
        now,
        typeof fact === 'function' ? fact(definition, result.definition) : fact,
      );
      return { ...result, validityId: stored.id };
    });
  }

  schedule(
    target: Target,
    channelId: string | null,
    input: Parameters<typeof schedulePrice>[1],
    now: Date,
    _fact?: PriceFactSource,
    eventContext?: { productId: string; correlationId: string },
  ) {
    return this.repository.transaction(async (tx) => {
      await this.lockSkuAndRejectDeactivated(tx, target);
      const { row, definition } = await this.load(tx, target, channelId);
      const plan = schedulePrice(definition, input, now);
      // Registrar intención futura y reservar su snapshot/version no equivale
      // a un cambio efectivo. El reconciliador produce el hecho al activarla.
      const validity = await this.persist(
        tx,
        row.id,
        plan,
        row.priceVersion,
        now,
      );
      const [scheduled] = await tx
        .insert(scheduledPrices)
        .values({
          id: randomUUID(),
          priceId: row.id,
          validityId: validity.id,
          productId:
            eventContext?.productId ??
            ('productId' in target ? target.productId : null),
          correlationId: eventContext?.correlationId ?? randomUUID(),
          tipoPrecio: input.tipoPrecio,
          importe: input.importe,
        })
        .returning();
      return { definition: plan, scheduled };
    });
  }

  private async lockSkuAndRejectDeactivated(
    tx: PricingTransaction,
    target: Target,
  ): Promise<void> {
    if (target.sku === undefined) return;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'sku-deactivation:' + target.sku}, 0))`,
    );
    const accepted = await tx.execute<{ accepted: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pricing.inbox
        WHERE handler = 'pricing.catalog-sku-deactivated.v1'
          AND result = 'APPLIED'
          AND payload->'data'->>'sku' = ${target.sku}
      ) AS accepted
    `);
    requireRule(!accepted.rows[0]?.accepted, 'PRECIO_NO_ENCONTRADO');
  }

  private async loadMaybe(
    tx: PricingTransaction,
    target: Target,
    channelId: string | null,
  ) {
    const [row] = await tx
      .select()
      .from(prices)
      .where(
        and(
          target.productId !== undefined
            ? eq(prices.productId, target.productId)
            : eq(prices.sku, target.sku),
          channelId === null
            ? isNull(prices.channelId)
            : eq(prices.channelId, channelId),
        ),
      )
      .for('update');
    if (!row) return undefined;
    const validities = await tx
      .select()
      .from(priceValidities)
      .where(eq(priceValidities.priceId, row.id));
    const definition: PriceDefinition = {
      target:
        row.productId !== null
          ? { productId: row.productId, sku: null }
          : { productId: null, sku: row.sku! },
      channelId: row.channelId,
      priceVersion: row.priceVersion,
      // El dominio no recibe PK/FK del snapshot: un cambio crea una identidad nueva.
      validities: validities.map((value) => ({
        precioRegular: value.precioRegular,
        precioOferta: value.precioOferta,
        currency: value.currency,
        motivoCambio: value.motivoCambio,
        usuarioId: value.usuarioId,
        validFrom: value.validFrom,
        validUntil: value.validUntil,
        priceVersion: value.priceVersion,
        isCancelled: value.isCancelled,
      })),
    };
    return { row, definition };
  }

  private async load(
    tx: PricingTransaction,
    target: Target,
    channelId: string | null,
  ) {
    const result = await this.loadMaybe(tx, target, channelId);
    requireRule(result !== undefined, 'PRECIO_NO_ENCONTRADO');
    return result;
  }

  private async persist(
    tx: PricingTransaction,
    priceId: string,
    plan: PriceDefinition,
    expected: bigint,
    now: Date,
    facts?: PriceFact | readonly PriceFact[],
  ) {
    const changed = await tx
      .update(prices)
      .set({ priceVersion: plan.priceVersion })
      .where(and(eq(prices.id, priceId), eq(prices.priceVersion, expected)))
      .returning();
    requireRule(changed.length === 1, 'VERSION_CONFLICT');
    for (const validity of plan.validities) {
      if (validity.priceVersion === plan.priceVersion) continue;
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
    const incoming = plan.validities.find(
      (value) => value.priceVersion === plan.priceVersion,
    )!;
    const [stored] = await tx
      .insert(priceValidities)
      .values({ ...incoming, priceId })
      .returning();
    if (facts) {
      const rows = Array.isArray(facts) ? facts : [facts];
      if (rows.length)
        await tx.insert(outbox).values(
          rows.map((fact) => ({
            ...fact,
            eventName: 'pricing.price.changed',
            kind: 'event' as const,
            schemaVersion: 1,
            occurredAt: now,
          })),
        );
    }
    return stored;
  }
}
