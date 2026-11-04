import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { PromotionsQueryRepository } from './query-repository.js';

type Database = NodePgDatabase<typeof schema>;
export type NewPromotion = Omit<
  typeof schema.promotions.$inferInsert,
  'id' | 'createdAt' | 'updatedAt' | 'firstActivatedAt'
>;
export type PromotionScope = Pick<
  typeof schema.promotionScopes.$inferInsert,
  'productId' | 'sku'
>;
export type CombinationPolicy = Pick<
  typeof schema.combinationPolicy.$inferInsert,
  'pricingOffer' | 'automaticPromotion' | 'coupon'
>;
export type NewCoupon = Omit<
  typeof schema.coupons.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;
export type NewRecommendation = Omit<
  typeof schema.recommendationRules.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;
export type RecommendationItem = Omit<
  typeof schema.recommendationItems.$inferInsert,
  'id' | 'ruleId' | 'createdAt' | 'updatedAt'
>;

class PromotionRepository {
  constructor(private readonly db: Database) {}

  async lock(id: string) {
    await this.db
      .select({ id: schema.promotions.id })
      .from(schema.promotions)
      .where(eq(schema.promotions.id, id))
      .for('update');
  }

  async replaceConfiguration(
    id: string,
    scopes: readonly PromotionScope[],
    policy: CombinationPolicy,
  ) {
    await this.db
      .delete(schema.promotionScopes)
      .where(eq(schema.promotionScopes.promotionId, id));
    await this.db
      .insert(schema.promotionScopes)
      .values(scopes.map((scope) => ({ ...scope, promotionId: id })));
    await this.db
      .update(schema.combinationPolicy)
      .set(policy)
      .where(eq(schema.combinationPolicy.promotionId, id));
  }

  async create(
    promotion: NewPromotion,
    scopes: readonly PromotionScope[],
    policy: CombinationPolicy,
  ) {
    const [saved] = await this.db
      .insert(schema.promotions)
      .values(promotion)
      .returning();
    if (scopes.length)
      await this.db
        .insert(schema.promotionScopes)
        .values(scopes.map((scope) => ({ ...scope, promotionId: saved.id })));
    await this.db
      .insert(schema.combinationPolicy)
      .values({ ...policy, promotionId: saved.id });
    return saved;
  }

  async findById(id: string) {
    const [promotion] = await this.db
      .select()
      .from(schema.promotions)
      .where(eq(schema.promotions.id, id));
    if (!promotion) return undefined;
    const scopes = await this.db
      .select()
      .from(schema.promotionScopes)
      .where(eq(schema.promotionScopes.promotionId, id))
      .orderBy(asc(schema.promotionScopes.id));
    const [policy] = await this.db
      .select()
      .from(schema.combinationPolicy)
      .where(eq(schema.combinationPolicy.promotionId, id));
    return { ...promotion, scopes, policy };
  }

  async update(id: string, changes: Partial<NewPromotion>) {
    const [updated] = await this.db
      .update(schema.promotions)
      .set(changes)
      .where(eq(schema.promotions.id, id))
      .returning();
    return updated;
  }
}

class CouponRepository {
  constructor(private readonly db: Database) {}

  async lock(id: string) {
    await this.db
      .select({ id: schema.coupons.id })
      .from(schema.coupons)
      .where(eq(schema.coupons.id, id))
      .for('update');
  }

  async create(coupon: NewCoupon) {
    const [saved] = await this.db
      .insert(schema.coupons)
      .values(coupon)
      .returning();
    return saved;
  }

  async findByCode(code: string) {
    const [coupon] = await this.db
      .select()
      .from(schema.coupons)
      .where(
        eq(schema.coupons.code, sql`promotions.fn_normalize_code(${code})`),
      );
    return coupon;
  }

  async update(id: string, changes: Partial<NewCoupon>) {
    const [updated] = await this.db
      .update(schema.coupons)
      .set(changes)
      .where(eq(schema.coupons.id, id))
      .returning();
    return updated;
  }

  listUses(orderId: string) {
    return this.db
      .select()
      .from(schema.couponUses)
      .where(eq(schema.couponUses.orderId, orderId))
      .orderBy(asc(schema.couponUses.id));
  }
}

class RecommendationRepository {
  constructor(private readonly db: Database) {}

  async lock(id: string) {
    await this.db
      .select({ id: schema.recommendationRules.id })
      .from(schema.recommendationRules)
      .where(eq(schema.recommendationRules.id, id))
      .for('update');
  }

  async replaceItems(id: string, items: readonly RecommendationItem[]) {
    await this.db
      .delete(schema.recommendationItems)
      .where(eq(schema.recommendationItems.ruleId, id));
    await this.db
      .insert(schema.recommendationItems)
      .values(items.map((item) => ({ ...item, ruleId: id })));
  }

  async create(rule: NewRecommendation, items: readonly RecommendationItem[]) {
    const [saved] = await this.db
      .insert(schema.recommendationRules)
      .values(rule)
      .returning();
    if (items.length)
      await this.db
        .insert(schema.recommendationItems)
        .values(items.map((item) => ({ ...item, ruleId: saved.id })));
    return saved;
  }

  async findById(id: string) {
    const [rule] = await this.db
      .select()
      .from(schema.recommendationRules)
      .where(eq(schema.recommendationRules.id, id));
    if (!rule) return undefined;
    const items = await this.db
      .select()
      .from(schema.recommendationItems)
      .where(eq(schema.recommendationItems.ruleId, id))
      .orderBy(
        asc(schema.recommendationItems.itemOrder),
        asc(schema.recommendationItems.id),
      );
    return { ...rule, items };
  }

  async update(id: string, changes: Partial<NewRecommendation>) {
    const [updated] = await this.db
      .update(schema.recommendationRules)
      .set(changes)
      .where(eq(schema.recommendationRules.id, id))
      .returning();
    return updated;
  }
}

// The repositories are scoped to the transaction's single client. They add no
// HTTP handlers or domain decisions, and never consume/restore coupons.
export class PromotionsRepositories {
  readonly queries: PromotionsQueryRepository;
  readonly promotions: PromotionRepository;
  readonly coupons: CouponRepository;
  readonly recommendations: RecommendationRepository;
  constructor(private readonly db: Database) {
    this.queries = new PromotionsQueryRepository(db);
    this.promotions = new PromotionRepository(db);
    this.coupons = new CouponRepository(db);
    this.recommendations = new RecommendationRepository(db);
  }

  async catalog(referenceType: string, referenceId: string) {
    const [projection] = await this.db
      .select()
      .from(schema.catalogProjection)
      .where(
        and(
          eq(schema.catalogProjection.referenceType, referenceType),
          eq(schema.catalogProjection.referenceId, referenceId),
        ),
      );
    return projection;
  }

  async price(sku: string, channelId: string | null) {
    // Invalidation is durable in Inbox. A PRODUCTO price change conservatively
    // invalidates the channel when a complete local product→SKU map is unavailable.
    // A completed handled Inbox marker is a persistent tombstone: no version/time
    // comparison or automatic revalidation occurs, even after projection updates.
    // HTTP reads supply current business facts but do not clear this tombstone.
    // See REVISION-PR143-TRANSPORTE-INVALIDACIONES.md before any Inbox retention.
    const invalidated = await this.db
      .select({ messageId: schema.inbox.messageId })
      .from(schema.inbox)
      .where(
        sql`
      ${schema.inbox.handler}='promotions-assigned-events-v1' AND ${schema.inbox.result}->>'handled'='true'
      AND ${schema.inbox.completedAt} IS NOT NULL AND ${schema.inbox.result}->'invalidation'->>'domain'='price'
      AND (${schema.inbox.result}->'invalidation'->>'channelId' IS NULL OR ${schema.inbox.result}->'invalidation'->>'channelId'=${channelId})
      AND (${schema.inbox.result}->'invalidation'->>'targetType'='PRODUCTO' OR ${schema.inbox.result}->'invalidation'->>'targetId'=${sku})`,
      )
      .limit(1);
    if (invalidated.length) return undefined;
    const [projection] = await this.db
      .select()
      .from(schema.priceProjection)
      .where(
        and(
          eq(schema.priceProjection.sku, sku),
          channelId === null
            ? isNull(schema.priceProjection.channelId)
            : eq(schema.priceProjection.channelId, channelId),
        ),
      );
    return projection;
  }

  async stock(sku: string) {
    // Any completed stock invalidation hides this SKU's cached availability,
    // regardless of location/version. Never aggregate locations or reconstruct
    // commercial availability from the event; the marker survives ordinary reads.
    const invalidated = await this.db
      .select({ messageId: schema.inbox.messageId })
      .from(schema.inbox)
      .where(
        sql`
      ${schema.inbox.handler}='promotions-assigned-events-v1' AND ${schema.inbox.result}->>'handled'='true'
      AND ${schema.inbox.completedAt} IS NOT NULL AND ${schema.inbox.result}->'invalidation'->>'domain'='stock'
      AND ${schema.inbox.result}->'invalidation'->>'targetId'=${sku}`,
      )
      .limit(1);
    if (invalidated.length) return undefined;
    const [projection] = await this.db
      .select()
      .from(schema.stockProjection)
      .where(eq(schema.stockProjection.sku, sku));
    return projection;
  }

  async receipt(operationId: string) {
    const [receipt] = await this.db
      .select()
      .from(schema.couponCommandReceipts)
      .where(eq(schema.couponCommandReceipts.operationId, operationId));
    return receipt;
  }

  async inbox(messageId: string, handler: string) {
    // Read-only receipt lookup: no ACK, replay, cache refresh or marker removal.
    const [entry] = await this.db
      .select()
      .from(schema.inbox)
      .where(
        and(
          eq(schema.inbox.messageId, messageId),
          eq(schema.inbox.handler, handler),
        ),
      );
    return entry;
  }

  async outbox(messageId: string) {
    const [entry] = await this.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.messageId, messageId));
    return entry;
  }
}
