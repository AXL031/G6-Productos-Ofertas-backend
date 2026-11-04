import {
  and,
  arrayContains,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
} from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from './schema.js';
type Database = NodePgDatabase<typeof s>;
export interface PageFilter {
  pagina: number;
  tamanio: number;
  estado?: string;
  modalidad?: string;
  tipo?: string;
}
const page = (f: PageFilter) => ({
  limit: f.tamanio,
  offset: (f.pagina - 1) * f.tamanio,
});
export class PromotionsQueryRepository {
  constructor(private readonly db: Database) {}
  async summaries(
    channel: string,
    current: boolean,
    state: string | undefined,
    at: string,
  ) {
    return this.db
      .select()
      .from(s.promotions)
      .where(
        and(
          arrayContains(s.promotions.enabledChannels, [channel]),
          state ? eq(s.promotions.state, state) : undefined,
          current
            ? and(
                eq(s.promotions.state, 'ACTIVO'),
                lte(s.promotions.validFrom, at),
                gt(s.promotions.validUntil, at),
              )
            : undefined,
        ),
      )
      .orderBy(asc(s.promotions.priority), asc(s.promotions.id));
  }
  async promotions(filter: PageFilter) {
    const where = and(
      filter.estado ? eq(s.promotions.state, filter.estado) : undefined,
      filter.modalidad
        ? eq(s.promotions.modality, filter.modalidad)
        : undefined,
    );
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(s.promotions)
      .where(where);
    const { limit, offset } = page(filter);
    if (offset >= total) return { rows: [], total };
    const rows = await this.db
      .select()
      .from(s.promotions)
      .where(where)
      .orderBy(asc(s.promotions.priority), asc(s.promotions.id))
      .limit(limit)
      .offset(offset);
    return { rows: await this.promotionsWithChildren(rows), total };
  }
  async promotion(id: string) {
    const rows = await this.db
      .select()
      .from(s.promotions)
      .where(eq(s.promotions.id, id));
    return (await this.promotionsWithChildren(rows))[0];
  }
  async promotionsByIds(ids: readonly string[]) {
    if (!ids.length) return [];
    return this.promotionsWithChildren(
      await this.db
        .select()
        .from(s.promotions)
        .where(inArray(s.promotions.id, [...ids]))
        .orderBy(asc(s.promotions.priority), asc(s.promotions.id)),
    );
  }
  private async promotionsWithChildren(
    rows: (typeof s.promotions.$inferSelect)[],
  ) {
    if (!rows.length) return [];
    const ids = rows.map((p) => p.id);
    const scopes = await this.db
      .select()
      .from(s.promotionScopes)
      .where(inArray(s.promotionScopes.promotionId, ids))
      .orderBy(asc(s.promotionScopes.id));
    const policies = await this.db
      .select()
      .from(s.combinationPolicy)
      .where(inArray(s.combinationPolicy.promotionId, ids));
    const coupons = await this.db
      .select({ id: s.coupons.promotionId, total: count() })
      .from(s.coupons)
      .where(inArray(s.coupons.promotionId, ids))
      .groupBy(s.coupons.promotionId);
    const uses = await this.db
      .select({ id: s.couponUses.promotionId, total: count() })
      .from(s.couponUses)
      .where(inArray(s.couponUses.promotionId, ids))
      .groupBy(s.couponUses.promotionId);
    return rows.map((p) => ({
      ...p,
      scopes: scopes.filter((v) => v.promotionId === p.id),
      policy: policies.find((v) => v.promotionId === p.id),
      couponCount: coupons.find((v) => v.id === p.id)?.total ?? 0,
      historicalUseCount: uses.find((v) => v.id === p.id)?.total ?? 0,
    }));
  }
  async coupons(filter: PageFilter) {
    const where = filter.estado
      ? eq(s.coupons.state, filter.estado)
      : undefined;
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(s.coupons)
      .where(where);
    const { limit, offset } = page(filter);
    if (offset >= total) return { rows: [], total };
    const rows = await this.db
      .select()
      .from(s.coupons)
      .where(where)
      .orderBy(asc(s.coupons.code), asc(s.coupons.id))
      .limit(limit)
      .offset(offset);
    return { rows: await this.couponsWithUses(rows), total };
  }
  async coupon(id: string) {
    return (
      await this.couponsWithUses(
        await this.db.select().from(s.coupons).where(eq(s.coupons.id, id)),
      )
    )[0];
  }
  private async couponsWithUses(rows: (typeof s.coupons.$inferSelect)[]) {
    if (!rows.length) return [];
    const totals = await this.db
      .select({ id: s.couponUses.couponId, total: count() })
      .from(s.couponUses)
      .where(
        and(
          inArray(
            s.couponUses.couponId,
            rows.map((v) => v.id),
          ),
          isNull(s.couponUses.restoredAt),
        ),
      )
      .groupBy(s.couponUses.couponId);
    return rows.map((c) => ({
      ...c,
      used: totals.find((v) => v.id === c.id)?.total ?? 0,
    }));
  }
  async couponUsage(id: string, customerRef: string | null) {
    const [{ used }] = await this.db
      .select({ used: count() })
      .from(s.couponUses)
      .where(
        and(eq(s.couponUses.couponId, id), isNull(s.couponUses.restoredAt)),
      );
    const customer = customerRef
      ? (
          await this.db
            .select({ used: count() })
            .from(s.couponUses)
            .where(
              and(
                eq(s.couponUses.couponId, id),
                eq(s.couponUses.customerRef, customerRef),
                isNull(s.couponUses.restoredAt),
              ),
            )
        )[0].used
      : 0;
    return { used, customerUsed: customer };
  }
  async rules(filter: PageFilter) {
    const where = and(
      filter.estado
        ? eq(s.recommendationRules.state, filter.estado)
        : undefined,
      filter.tipo
        ? eq(s.recommendationRules.recommendationType, filter.tipo)
        : undefined,
    );
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(s.recommendationRules)
      .where(where);
    const { limit, offset } = page(filter);
    if (offset >= total) return { rows: [], total };
    const rows = await this.db
      .select()
      .from(s.recommendationRules)
      .where(where)
      .orderBy(
        asc(s.recommendationRules.priority),
        asc(s.recommendationRules.id),
      )
      .limit(limit)
      .offset(offset);
    return { rows: await this.rulesWithItems(rows), total };
  }
  async rule(id: string) {
    return (
      await this.rulesWithItems(
        await this.db
          .select()
          .from(s.recommendationRules)
          .where(eq(s.recommendationRules.id, id)),
      )
    )[0];
  }
  private async rulesWithItems(
    rows: (typeof s.recommendationRules.$inferSelect)[],
  ) {
    if (!rows.length) return [];
    const items = await this.db
      .select()
      .from(s.recommendationItems)
      .where(
        inArray(
          s.recommendationItems.ruleId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(
        asc(s.recommendationItems.itemOrder),
        asc(s.recommendationItems.id),
      );
    return rows.map((r) => ({
      ...r,
      items: items.filter((i) => i.ruleId === r.id),
    }));
  }
  async matchingRules(
    productId: string,
    categoryId: string | undefined,
    at: string,
  ) {
    // Product and category ownership stays in Catalog; category is supplied by the verified facts port.
    const conditions: SQL[] = [
      eq(s.recommendationRules.state, 'ACTIVO'),
      lte(s.recommendationRules.validFrom, at),
      gt(s.recommendationRules.validUntil, at),
    ];
    conditions.push(
      or(
        and(
          eq(s.recommendationRules.originType, 'PRODUCTO'),
          eq(s.recommendationRules.originId, productId),
        ),
        categoryId
          ? and(
              eq(s.recommendationRules.originType, 'CATEGORIA'),
              eq(s.recommendationRules.originId, categoryId),
            )
          : undefined,
      )!,
    );
    const rows = await this.db
      .select()
      .from(s.recommendationRules)
      .where(and(...conditions))
      .orderBy(
        asc(s.recommendationRules.priority),
        asc(s.recommendationRules.id),
      );
    return this.rulesWithItems(
      rows.filter((r) =>
        r.originType === 'PRODUCTO'
          ? r.originId === productId
          : r.originType === 'CATEGORIA' && r.originId === categoryId,
      ),
    );
  }
  async hasActiveRules(at: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: s.recommendationRules.id })
      .from(s.recommendationRules)
      .where(
        and(
          eq(s.recommendationRules.state, 'ACTIVO'),
          lte(s.recommendationRules.validFrom, at),
          gt(s.recommendationRules.validUntil, at),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
export type PromotionQueryRow = NonNullable<
  Awaited<ReturnType<PromotionsQueryRepository['promotion']>>
>;
export type CouponQueryRow = NonNullable<
  Awaited<ReturnType<PromotionsQueryRepository['coupon']>>
>;
export type RuleQueryRow = NonNullable<
  Awaited<ReturnType<PromotionsQueryRepository['rule']>>
>;
