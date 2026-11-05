import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { PricingRepository } from '../persistence/pricing.repository.js';
import {
  inbox,
  priceValidities,
  prices,
  scheduledPrices,
} from '../persistence/pricing.schema.js';

const HANDLER = 'pricing.catalog-sku-deactivated.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
@Injectable()
export class CatalogSkuDeactivated {
  constructor(private readonly repository: PricingRepository) {}

  async consume(
    raw: Buffer,
  ): Promise<'APPLIED' | 'DUPLICATE' | 'STALE' | 'REJECTED'> {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      throw new Error('PRICING_INVALID_MESSAGE_JSON');
    }
    if (
      !object(value) ||
      !UUID.test(String(value.message_id)) ||
      value.schema_version !== 1 ||
      typeof value.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(value.occurred_at)) ||
      !UUID.test(String(value.correlation_id)) ||
      !UUID.test(String(value.operation_id)) ||
      value.producer !== 'catalog-svc' ||
      value.kind !== 'event' ||
      value.name !== 'catalog.sku.deactivated' ||
      !object(value.data)
    )
      throw new Error('PRICING_INVALID_MESSAGE_ENVELOPE');

    const message = value;
    const data = message.data as Record<string, unknown>;
    const validIdentity =
      typeof data.sku === 'string' &&
      data.sku.length > 0 &&
      typeof data.product_id === 'string' &&
      data.product_id.length > 0;
    const versionValid =
      Number.isSafeInteger(data.sku_version) && Number(data.sku_version) >= 1;
    const changedAt =
      typeof data.changed_at === 'string'
        ? new Date(data.changed_at)
        : undefined;
    const changedAtValid =
      changedAt !== undefined && Number.isFinite(changedAt.getTime());
    const disposition = !validIdentity || !versionValid || !changedAtValid;
    const sku = validIdentity ? (data.sku as string) : '';
    const skuVersion = versionValid ? Number(data.sku_version) : null;

    return this.repository.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${message.operation_id as string}, 0))`,
      );
      if (sku)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${'sku-deactivation:' + sku}, 0))`,
        );
      const [previousMessage] = await tx
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, message.message_id as string),
            eq(inbox.handler, HANDLER),
          ),
        )
        .limit(1);
      if (previousMessage) {
        if (canonical(previousMessage.payload) !== canonical(message))
          throw new Error('PRICING_MESSAGE_ID_CONFLICT');
        return 'DUPLICATE';
      }
      const priorOperation = await tx
        .select({ payload: inbox.payload })
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, HANDLER),
            sql`${inbox.payload}->>'operation_id' = ${message.operation_id as string}`,
          ),
        )
        .limit(1);
      if (priorOperation.length) {
        const previous = priorOperation[0].payload;
        const previousData =
          object(previous) && object(previous.data) ? previous.data : {};
        const result =
          canonical(previousData) === canonical(data)
            ? 'DUPLICATE'
            : 'REJECTED_OPERATION_ID_CONFLICT';
        await tx.insert(inbox).values({
          messageId: message.message_id as string,
          handler: HANDLER,
          eventName: message.name as string,
          correlationId: message.correlation_id as string,
          payload: message,
          result,
        });
        return result === 'DUPLICATE' ? 'DUPLICATE' : 'REJECTED';
      }
      if (disposition) {
        await tx.insert(inbox).values({
          messageId: message.message_id as string,
          handler: HANDLER,
          eventName: message.name as string,
          correlationId: message.correlation_id as string,
          payload: message,
          result: 'REJECTED_MISSING_SKU_VERSION_OR_CONTEXT',
        });
        return 'REJECTED';
      }

      const priorRows = await tx
        .select({ payload: inbox.payload })
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, HANDLER),
            eq(inbox.result, 'APPLIED'),
            sql`${inbox.payload}->'data'->>'sku' = ${sku}`,
            sql`(${inbox.payload}->'data'->>'sku_version') IS NOT NULL`,
          ),
        );
      const latestVersion = priorRows.reduce((latest, row) => {
        const priorData =
          object(row.payload) && object(row.payload.data)
            ? row.payload.data
            : {};
        const priorVersion = Number(priorData.sku_version);
        return Number.isSafeInteger(priorVersion)
          ? Math.max(latest, priorVersion)
          : latest;
      }, 0);
      const stale = Number(skuVersion) <= latestVersion;
      if (!stale) {
        const affected = await tx
          .select({
            id: scheduledPrices.id,
            validityId: scheduledPrices.validityId,
            validFrom: priceValidities.validFrom,
          })
          .from(scheduledPrices)
          .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
          .innerJoin(
            priceValidities,
            eq(priceValidities.id, scheduledPrices.validityId),
          )
          .where(
            and(eq(prices.sku, sku), eq(scheduledPrices.status, 'SCHEDULED')),
          )
          .for('update');
        for (const row of affected) {
          const future = row.validFrom >= changedAt!;
          if (future)
            await tx
              .update(priceValidities)
              .set({ isCancelled: true })
              .where(eq(priceValidities.id, row.validityId));
          await tx
            .update(scheduledPrices)
            .set({ status: future ? 'CANCELLED' : 'HISTORICAL' })
            .where(
              and(
                eq(scheduledPrices.id, row.id),
                eq(scheduledPrices.status, 'SCHEDULED'),
              ),
            );
        }
      }
      await tx.insert(inbox).values({
        messageId: message.message_id as string,
        handler: HANDLER,
        eventName: message.name as string,
        correlationId: message.correlation_id as string,
        payload: message,
        result: stale ? 'STALE' : 'APPLIED',
      });
      return stale ? 'STALE' : 'APPLIED';
    });
  }
}
