import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { evaluateBasket } from '../domain/basket-evaluation.js';
import type { ResolvedBasket } from '../domain/commercial-context.js';
import { normalizeCouponCode } from '../domain/promotion-rules.js';
import { PromotionsRepositories } from '../infrastructure/persistence/repositories.js';
import * as schema from '../infrastructure/persistence/schema.js';
import { consumptionName, type CouponCommand } from './coupon-command.js';
import type {
  ConsumptionEvidence,
  CouponEvidenceProvider,
} from './coupon-transactions.js';

// Internal verified facts, NOT a new G5/Inventory wire DTO. An authorized source
// must resolve and bind the durable snapshot and reservation before returning.
// G5's current pedido DTO alone cannot supply regular/offer prices or prove a
// reservation. No HTTP endpoint or cross-schema query is inferred here.
export interface DurableCouponFacts {
  orderId: string;
  reservationId: string;
  commercialSnapshotRef: string;
  reservationConfirmed: boolean;
  snapshotDurable: boolean;
  effectiveAt: string;
  customerRef: string | null;
  channelId: string;
  couponCode: string;
  basket: ResolvedBasket;
}
export interface CouponDurableFactsSource {
  read(
    command: CouponCommand,
    signal: AbortSignal,
  ): Promise<DurableCouponFacts>;
}

// Deliberately not registered in Nest: the real facts source/identity remains a
// specific integration dependency. SQL uses the processor's existing client;
// there is no second pool, transaction, migration or production fixture.
export class AuthoritativeCouponEvidence implements CouponEvidenceProvider<PoolClient> {
  private readonly prepared = new WeakMap<
    ConsumptionEvidence,
    DurableCouponFacts
  >();
  constructor(private readonly source: CouponDurableFactsSource) {}

  async verify(
    command: CouponCommand,
    signal: AbortSignal,
  ): Promise<ConsumptionEvidence> {
    signal.throwIfAborted();
    if (command.name !== consumptionName)
      throw new Error('COUPON_EVIDENCE_UNAVAILABLE');
    // Read external evidence before acquiring coupon/promotion row locks. The
    // processor bounds this entire call and already serializes order/operation.
    const facts = await this.source.read(command, signal);
    signal.throwIfAborted();
    const proof: ConsumptionEvidence = {
      orderId: facts.orderId,
      reservationId: facts.reservationId,
      commercialSnapshotRef: facts.commercialSnapshotRef,
      reservationConfirmed: facts.reservationConfirmed === true,
      snapshotDurable: facts.snapshotDurable === true,
      eligible: false,
    };
    if (
      !proof.reservationConfirmed ||
      !proof.snapshotDurable ||
      facts.orderId !== command.data.order_id ||
      facts.reservationId.toLowerCase() !==
        command.data.reservation_id?.toLowerCase() ||
      facts.commercialSnapshotRef !== command.data.commercial_snapshot_ref ||
      facts.channelId !== command.data.channel_id ||
      facts.customerRef?.toLowerCase() !==
        command.data.customer_ref?.toLowerCase() ||
      normalizeCouponCode(facts.couponCode) !==
        normalizeCouponCode(command.data.coupon_code ?? '') ||
      !Number.isFinite(Date.parse(facts.effectiveAt)) ||
      Date.parse(facts.effectiveAt) !==
        Date.parse(command.data.effective_at ?? '')
    )
      return proof;
    if (
      !facts.basket.lines.length ||
      facts.basket.lines.some(
        (l) =>
          !l.sku.trim() ||
          !l.productId.trim() ||
          !Number.isSafeInteger(l.quantity) ||
          l.quantity <= 0,
      ) ||
      new Set(facts.basket.lines.map((l) => l.sku)).size !==
        facts.basket.lines.length
    )
      throw new Error('COUPON_EVIDENCE_UNAVAILABLE');

    this.prepared.set(proof, facts);
    return proof;
  }

  async revalidate(
    _command: CouponCommand,
    proof: ConsumptionEvidence,
    client: PoolClient,
  ): Promise<ConsumptionEvidence> {
    const facts = this.prepared.get(proof);
    this.prepared.delete(proof);
    if (!facts) return proof;
    const repositories = new PromotionsRepositories(
      drizzle(client, { schema, logger: false }),
    );
    let coupon = await repositories.coupons.findByCode(facts.couponCode);
    if (!coupon) return proof;
    // Same lock order as the normative consume function/triggers. Configuration
    // changes cannot race scope/minimum/combination checks and final consumption.
    await repositories.coupons.lock(coupon.id);
    coupon = await repositories.coupons.findByCode(facts.couponCode);
    if (!coupon) return proof;
    await repositories.promotions.lock(coupon.promotionId);
    const active = await repositories.queries.summaries(
      facts.channelId,
      true,
      undefined,
      facts.effectiveAt,
    );
    const promotions = await repositories.queries.promotionsByIds([
      ...new Set([...active.map((p) => p.id), coupon.promotionId]),
    ]);
    const evaluation = evaluateBasket(
      {
        channel_id: facts.channelId,
        customer_ref: facts.customerRef,
        coupon_code: facts.couponCode,
        lines: facts.basket.lines.map((l) => ({
          sku: l.sku,
          quantity: l.quantity,
          product_id: l.productId,
        })),
      },
      facts.basket,
      promotions,
      {
        ...coupon,
        // Limits/required customer are revalidated by fn_consume_coupon under
        // its own lock, preserving the existing specific result codes.
        maxGlobalUses: null,
        maxCustomerUses: null,
        used: 0,
        customerUsed: 0,
      },
      facts.effectiveAt,
    );
    return {
      ...proof,
      eligible:
        // The primary automatic campaign does not identify the actual coupon.
        evaluation.couponApplicable &&
        evaluation.appliedCouponPromotionId === coupon.promotionId,
    };
  }
}
