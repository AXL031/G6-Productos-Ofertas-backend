import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import {
  contains,
  type PriceDefinition,
  type PriceValidity,
} from '../domain/price.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import {
  inbox,
  outbox,
  priceValidities,
  prices,
  scheduledPrices,
} from '../persistence/pricing.schema.js';
import { createPricingPriceChangedFacts } from './pricing-fact.js';

const BATCH_SIZE = 25;

function deterministicMessageId(scheduleId: string, component: string): string {
  const hex = createHash('sha256')
    .update(`pricing-schedule:${scheduleId}:${component}`)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function toValidity(value: typeof priceValidities.$inferSelect): PriceValidity {
  return {
    precioRegular: value.precioRegular,
    precioOferta: value.precioOferta,
    currency: value.currency,
    motivoCambio: value.motivoCambio,
    usuarioId: value.usuarioId,
    validFrom: value.validFrom,
    validUntil: value.validUntil,
    priceVersion: value.priceVersion,
    isCancelled: value.isCancelled,
  };
}

@Injectable()
export class PricingScheduleReconciler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private readonly observedManualSchedules = new Set<string>();
  private readonly logger = new Logger(PricingScheduleReconciler.name);

  constructor(
    @Inject(PricingRepository) private readonly repository: PricingRepository,
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.nodeEnv === 'test') return;
    const tick = () => {
      this.active = this.runOnce()
        .then(() => undefined)
        .catch(() => {
          this.logger.warn('Reconciliación de programaciones pendiente.');
        })
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, 3000);
            this.timer.unref();
          }
        });
    };
    tick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  runOnce(
    now = new Date(),
  ): Promise<{ activated: number; historical: number }> {
    return this.repository.transaction(async (tx) => {
      const legacyPending = await tx
        .select({ id: scheduledPrices.id })
        .from(scheduledPrices)
        .innerJoin(
          priceValidities,
          eq(priceValidities.id, scheduledPrices.validityId),
        )
        .where(
          and(
            eq(scheduledPrices.status, 'SCHEDULED'),
            lte(priceValidities.validFrom, now),
            or(
              isNull(scheduledPrices.productId),
              isNull(scheduledPrices.correlationId),
              sql`btrim(${scheduledPrices.productId}) = ''`,
            ),
            or(
              sql`${priceValidities.validUntil} IS NULL`,
              sql`${priceValidities.validUntil} > ${now}`,
            ),
          ),
        );
      for (const row of legacyPending) {
        if (this.observedManualSchedules.has(row.id)) continue;
        this.observedManualSchedules.add(row.id);
        this.logger.warn(
          `Programación heredada requiere reconciliación manual (${row.id}).`,
        );
      }
      const due = await tx
        .select({
          scheduled: scheduledPrices,
          validity: priceValidities,
          price: prices,
        })
        .from(scheduledPrices)
        .innerJoin(
          priceValidities,
          eq(priceValidities.id, scheduledPrices.validityId),
        )
        .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
        .where(
          or(
            and(
              eq(scheduledPrices.status, 'SCHEDULED'),
              lte(priceValidities.validFrom, now),
              or(
                lte(priceValidities.validUntil, now),
                sql`${scheduledPrices.productId} IS NOT NULL AND btrim(${scheduledPrices.productId}) <> '' AND ${scheduledPrices.correlationId} IS NOT NULL`,
              ),
            ),
            and(
              eq(scheduledPrices.status, 'ACTIVE'),
              lte(priceValidities.validUntil, now),
            ),
          ),
        )
        .orderBy(asc(priceValidities.validFrom), asc(scheduledPrices.id))
        .limit(BATCH_SIZE);

      let activated = 0;
      let historical = 0;
      for (const item of due) {
        if (item.price.sku !== null)
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${'sku-deactivation:' + item.price.sku}, 0))`,
          );
        let deactivatedAt: Date | undefined;
        if (item.price.sku !== null) {
          const accepted = await tx
            .select({ payload: inbox.payload })
            .from(inbox)
            .where(
              and(
                eq(inbox.handler, 'pricing.catalog-sku-deactivated.v1'),
                eq(inbox.result, 'APPLIED'),
                sql`${inbox.payload}->'data'->>'sku' = ${item.price.sku}`,
              ),
            );
          for (const row of accepted) {
            const payload = row.payload;
            if (
              typeof payload === 'object' &&
              payload !== null &&
              'data' in payload &&
              typeof payload.data === 'object' &&
              payload.data !== null &&
              'changed_at' in payload.data &&
              typeof payload.data.changed_at === 'string'
            ) {
              const candidate = new Date(payload.data.changed_at);
              if (
                Number.isFinite(candidate.getTime()) &&
                (!deactivatedAt || candidate < deactivatedAt)
              )
                deactivatedAt = candidate;
            }
          }
        }
        const [current] = await tx
          .select({
            scheduled: scheduledPrices,
            validity: priceValidities,
            price: prices,
          })
          .from(scheduledPrices)
          .innerJoin(
            priceValidities,
            eq(priceValidities.id, scheduledPrices.validityId),
          )
          .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
          .where(
            and(
              eq(scheduledPrices.id, item.scheduled.id),
              or(
                and(
                  eq(scheduledPrices.status, 'SCHEDULED'),
                  lte(priceValidities.validFrom, now),
                ),
                and(
                  eq(scheduledPrices.status, 'ACTIVE'),
                  lte(priceValidities.validUntil, now),
                ),
              ),
            ),
          )
          .for('update');
        if (!current) continue;
        if (current.scheduled.status === 'ACTIVE') {
          if (
            current.validity.validUntil &&
            current.validity.validUntil <= now
          ) {
            await tx
              .update(scheduledPrices)
              .set({ status: 'HISTORICAL' })
              .where(
                and(
                  eq(scheduledPrices.id, current.scheduled.id),
                  eq(scheduledPrices.status, 'ACTIVE'),
                ),
              );
            historical++;
          }
          continue;
        }

        // An accepted Catalog deactivation is durable. A schedule that was
        // still pending at that point can never be materialized afterwards.
        // Its captured valid_from determines whether we retain it as cancelled
        // or historical; neither path creates an effective fact.
        if (deactivatedAt) {
          const future = current.validity.validFrom >= deactivatedAt;
          if (future)
            await tx
              .update(priceValidities)
              .set({ isCancelled: true })
              .where(eq(priceValidities.id, current.validity.id));
          const [closed] = await tx
            .update(scheduledPrices)
            .set({ status: future ? 'CANCELLED' : 'HISTORICAL' })
            .where(
              and(
                eq(scheduledPrices.id, current.scheduled.id),
                eq(scheduledPrices.status, 'SCHEDULED'),
              ),
            )
            .returning({ id: scheduledPrices.id });
          if (closed && !future) historical++;
          continue;
        }

        if (current.validity.validUntil && current.validity.validUntil <= now) {
          await tx
            .update(scheduledPrices)
            .set({ status: 'HISTORICAL' })
            .where(
              and(
                eq(scheduledPrices.id, current.scheduled.id),
                eq(scheduledPrices.status, 'SCHEDULED'),
              ),
            );
          historical++;
          continue;
        }

        // Legacy schedules without the captured Catalog context remain safe
        // and unactivated; no event is fabricated from a SKU-only identity.
        if (!current.scheduled.productId || !current.scheduled.correlationId)
          continue;

        const allRows = await tx
          .select()
          .from(priceValidities)
          .where(eq(priceValidities.priceId, current.price.id));
        const validities = allRows.map(toValidity);
        const afterValidity = toValidity(current.validity);
        const beforeAt = new Date(afterValidity.validFrom.getTime() - 1);
        const previous = validities.find((validity) =>
          contains(validity, beforeAt),
        );
        if (!previous) continue;
        const target =
          current.price.productId !== null
            ? { productId: current.price.productId, sku: null }
            : { productId: null, sku: current.price.sku! };
        const before: PriceDefinition = {
          target,
          channelId: current.price.channelId,
          priceVersion: previous.priceVersion,
          validities,
        };
        const after: PriceDefinition = {
          target,
          channelId: current.price.channelId,
          priceVersion: afterValidity.priceVersion,
          validities,
        };
        const actor = afterValidity.usuarioId;
        const facts = createPricingPriceChangedFacts(before, after, {
          actor,
          correlationId: current.scheduled.correlationId,
          at: afterValidity.validFrom,
          operation:
            current.price.sku === null
              ? 'programarPrecioBaseProducto'
              : 'programarPrecioSku',
          productId: current.scheduled.productId,
          operationId: current.scheduled.id,
        }).map((fact) => ({
          ...fact,
          // Keep deterministic identity per component; a single schedule can
          // produce both REGULAR and OFERTA facts.
          messageId: deterministicMessageId(
            current.scheduled.id,
            String(fact.payload.price_type),
          ),
        }));

        const changed = await tx
          .update(scheduledPrices)
          .set({ status: 'ACTIVE' })
          .where(
            and(
              eq(scheduledPrices.id, current.scheduled.id),
              eq(scheduledPrices.status, 'SCHEDULED'),
            ),
          )
          .returning({ id: scheduledPrices.id });
        if (!changed.length) continue;
        if (facts.length)
          await tx.insert(outbox).values(
            facts.map((fact) => ({
              ...fact,
              eventName: 'pricing.price.changed',
              kind: 'event' as const,
              schemaVersion: 1,
              occurredAt: now,
            })),
          );
        activated++;
      }
      return { activated, historical };
    });
  }
}
