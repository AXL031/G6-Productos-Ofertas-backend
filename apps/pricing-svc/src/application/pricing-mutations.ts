import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  changePrice,
  schedulePrice,
  requireRule,
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
  PriceFact | ((before: PriceDefinition, after: PriceDefinition) => PriceFact);

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
      const { row, definition } = await this.load(tx, target, channelId);
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
    fact: PriceFactSource,
  ) {
    return this.repository.transaction(async (tx) => {
      const { row, definition } = await this.load(tx, target, channelId);
      const plan = schedulePrice(definition, input, now);
      const validity = await this.persist(
        tx,
        row.id,
        plan,
        row.priceVersion,
        now,
        typeof fact === 'function' ? fact(definition, plan) : fact,
      );
      const [scheduled] = await tx
        .insert(scheduledPrices)
        .values({
          priceId: row.id,
          validityId: validity.id,
          tipoPrecio: input.tipoPrecio,
          importe: input.importe,
        })
        .returning();
      return { definition: plan, scheduled };
    });
  }

  private async load(
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
    requireRule(row !== undefined, 'PRECIO_NO_ENCONTRADO');
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

  private async persist(
    tx: PricingTransaction,
    priceId: string,
    plan: PriceDefinition,
    expected: bigint,
    now: Date,
    fact: PriceFact,
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
    await tx.insert(outbox).values({
      ...fact,
      eventName: 'pricing.price.changed',
      kind: 'event',
      schemaVersion: 1,
      occurredAt: now,
    });
    return stored;
  }
}
