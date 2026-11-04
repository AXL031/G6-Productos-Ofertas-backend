import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PromotionsPersistence } from '../infrastructure/persistence/promotions-persistence.js';
import type {
  CouponQueryRow,
  PromotionQueryRow,
  RuleQueryRow,
  PageFilter,
} from '../infrastructure/persistence/query-repository.js';
import {
  canChangeModality,
  rankRecommendations,
} from '../domain/promotion-rules.js';
import {
  COMMERCIAL_CONTEXT,
  CommercialDependencyError,
  type CommercialContext,
  type BasketRequest,
} from '../domain/commercial-context.js';
import { evaluateBasket } from '../domain/basket-evaluation.js';
import { Decimal } from '../domain/decimal.js';
import { PROMOTIONS_CLOCK, type PromotionsClock } from '../domain/clock.js';
import { BoundedCommercialContext } from '../infrastructure/resilience/commercial-deadline.js';
import { httpContracts } from './http-contract.generated.js';
import { withHttpClientSignal } from './client-cancellation.js';
import {
  isUuid,
  PromotionsHttpError,
  queryInput,
  valid,
  correlationId,
} from './http-validation.js';
const iso = (s: string) => new Date(s).toISOString();
export function promotionDto(p: PromotionQueryRow) {
  if (!p.policy) throw new Error('INCOMPLETE_PROMOTION_POLICY');
  return {
    promotionId: p.id,
    nombre: p.name,
    tipoDescuento: p.discountType,
    valor: Decimal.from(p.discountValue).toNumber(),
    modalidad: p.modality,
    estado: p.state,
    validFrom: iso(p.validFrom),
    validUntil: iso(p.validUntil),
    alcance: {
      productIds: p.scopes.flatMap((s) =>
        s.productId === null ? [] : [s.productId],
      ),
      skus: p.scopes.flatMap((s) => (s.sku === null ? [] : [s.sku])),
    },
    prioridad: p.priority,
    canalesHabilitados: p.enabledChannels,
    puedeCambiarModalidad: canChangeModality(
      p.state,
      p.firstActivatedAt,
      p.couponCount,
      p.historicalUseCount,
    ),
    politicaCombinacion: {
      ofertaPricing: p.policy.pricingOffer,
      promocionAutomatica: p.policy.automaticPromotion,
      cupon: p.policy.coupon,
    },
  };
}
export function couponDto(c: CouponQueryRow) {
  return {
    cuponId: c.id,
    codigo: c.code,
    promocionId: c.promotionId,
    estado: c.state,
    montoMinimo:
      c.minimumAmount === null
        ? null
        : Decimal.from(c.minimumAmount).toNumber(),
    maxUsosGlobal: c.maxGlobalUses,
    maxUsosPorCliente: c.maxCustomerUses,
    politicaCancelacion: c.cancellationPolicy,
    usosGlobalesConsumidos: c.used,
    usosDisponibles:
      c.maxGlobalUses === null ? null : Math.max(0, c.maxGlobalUses - c.used),
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}
export function ruleDto(r: RuleQueryRow) {
  return {
    reglaId: r.id,
    nombre: r.name,
    tipo: r.recommendationType,
    origen: { tipo: r.originType, id: r.originId },
    prioridad: r.priority,
    estado: r.state,
    validFrom: iso(r.validFrom),
    validUntil: iso(r.validUntil),
    recomendados: r.items.map((i) => ({
      productId: i.productId,
      orden: i.itemOrder,
      criterioSuperioridad: i.superiorityCriterion,
      justificacionComercial: i.commercialJustification,
    })),
  };
}
function paginated<T>(rows: T[], total: number, q: PageFilter) {
  return {
    items: rows,
    meta: {
      pagina: q.pagina,
      tamanio: q.tamanio,
      total,
      totalPaginas: Math.ceil(total / q.tamanio),
    },
  };
}
@Injectable()
export class PromotionsQueryService {
  private readonly facts: CommercialContext;
  constructor(
    @Inject(PromotionsPersistence)
    private readonly persistence: PromotionsPersistence,
    @Inject(COMMERCIAL_CONTEXT) facts: CommercialContext,
    @Inject(PROMOTIONS_CLOCK) private readonly clock: PromotionsClock,
  ) {
    this.facts = new BoundedCommercialContext(facts);
  }
  execute(id: string, request: Request): Promise<unknown> {
    return withHttpClientSignal(request, (signal) =>
      this.executeQuery(id, request, signal),
    );
  }
  private async executeQuery(
    id: string,
    request: Request,
    signal: AbortSignal,
  ): Promise<unknown> {
    const contract = httpContracts[id];
    const q = queryInput(request.query, contract);
    if (contract.body && !valid(request.body, contract.body))
      throw new PromotionsHttpError(400, 'VALIDACION');
    const now = this.clock.now().toISOString();
    const context = { correlationId: correlationId(request), at: now };
    let result: unknown;
    const filter: PageFilter = {
      pagina: Number(q.pagina ?? 1),
      tamanio: Number(q.tamanio ?? 20),
      estado: q.estado as string | undefined,
      modalidad: q.modalidad as string | undefined,
      tipo: q.tipo as string | undefined,
    };
    switch (id) {
      case 'listarPromociones':
        result = {
          items: (
            await this.persistence.read((r) =>
              r.queries.summaries(
                String(q.canal),
                q.vigentes !== false,
                q.estado as string | undefined,
                now,
              ),
            )
          ).map((p) => ({
            promotion_id: p.id,
            name: p.name,
            status: p.state === 'ACTIVO' ? 'ACTIVA' : 'INACTIVA',
            valid_from: iso(p.validFrom),
            valid_until: iso(p.validUntil),
            channels: p.enabledChannels,
          })),
        };
        break;
      case 'listarPromocionesAdmin': {
        const p = await this.persistence.read((r) =>
          r.queries.promotions(filter),
        );
        result = paginated(p.rows.map(promotionDto), p.total, filter);
        break;
      }
      case 'listarCupones': {
        const p = await this.persistence.read((r) => r.queries.coupons(filter));
        result = paginated(p.rows.map(couponDto), p.total, filter);
        break;
      }
      case 'listarReglasRecomendacion': {
        const p = await this.persistence.read((r) => r.queries.rules(filter));
        result = paginated(p.rows.map(ruleDto), p.total, filter);
        break;
      }
      case 'obtenerPromocionAdmin': {
        const value = request.params.promocionId;
        const p = isUuid(value)
          ? await this.persistence.read((r) => r.queries.promotion(value))
          : undefined;
        if (!p) throw new PromotionsHttpError(404, 'PROMOCION_NO_ENCONTRADA');
        result = promotionDto(p);
        break;
      }
      case 'obtenerCuponAdmin': {
        const value = request.params.cuponId;
        const c = isUuid(value)
          ? await this.persistence.read((r) => r.queries.coupon(value))
          : undefined;
        if (!c) throw new PromotionsHttpError(404, 'CUPON_NO_ENCONTRADO');
        result = couponDto(c);
        break;
      }
      case 'obtenerReglaRecomendacion': {
        const value = request.params.reglaId;
        const r = isUuid(value)
          ? await this.persistence.read((v) => v.queries.rule(value))
          : undefined;
        if (!r)
          throw new PromotionsHttpError(
            404,
            'REGLA_RECOMENDACION_NO_ENCONTRADA',
          );
        result = ruleDto(r);
        break;
      }
      case 'evaluarPromociones':
      case 'validarCupon': {
        const raw = request.body as BasketRequest;
        const body: BasketRequest = {
          channel_id: raw.channel_id,
          lines: raw.lines.map((l) => ({
            sku: l.sku,
            quantity: l.quantity,
            ...(l.product_id !== undefined ? { product_id: l.product_id } : {}),
          })),
          coupon_code: raw.coupon_code,
          customer_ref: raw.customer_ref,
          ...(id === 'evaluarPromociones' ? { at: raw.at } : {}),
        };
        const at = id === 'evaluarPromociones' ? (body.at ?? now) : now;
        // External calls precede the short, read-only database transaction.
        const basketContext = await this.facts.basket(body, at, signal, {
          ...context,
          at,
        });
        signal.throwIfAborted();
        const snapshot = await this.persistence.read(async (r) => {
          const active = await r.queries.summaries(
            body.channel_id,
            true,
            undefined,
            at,
          );
          const coupon = body.coupon_code
            ? await r.coupons.findByCode(body.coupon_code)
            : undefined;
          const ids = new Set(
            id === 'validarCupon' ? [] : active.map((p) => p.id),
          );
          if (coupon) ids.add(coupon.promotionId);
          const promotions = await r.queries.promotionsByIds([...ids]);
          const usage = coupon
            ? await r.queries.couponUsage(coupon.id, body.customer_ref ?? null)
            : undefined;
          return {
            promotions,
            coupon: coupon && usage ? { ...coupon, ...usage } : undefined,
          };
        });
        const evaluation = evaluateBasket(
          body,
          basketContext,
          snapshot.promotions,
          snapshot.coupon,
          at,
          id === 'validarCupon',
        );
        if (id === 'evaluarPromociones')
          result = {
            promotion_id: evaluation.promotionId,
            original_amount: evaluation.original.toNumber(),
            discount_amount: evaluation.discount.toNumber(),
            result_amount: evaluation.result.toNumber(),
            currency: evaluation.currency,
            reason: evaluation.couponRejection ?? null,
          };
        else {
          const candidate = evaluation.couponCandidate;
          const validCoupon = evaluation.couponApplicable && !!candidate;
          result = {
            valid: validCoupon,
            code: validCoupon
              ? null
              : (evaluation.couponRejection ?? 'CUPON_NO_COMBINABLE'),
            benefit: validCoupon ? { promotion_id: candidate!.id } : null,
            discount_amount: validCoupon
              ? evaluation.original.subtract(candidate!.resultAmount).toNumber()
              : 0,
            result_amount: validCoupon
              ? candidate!.resultAmount.toNumber()
              : evaluation.original.toNumber(),
            currency: evaluation.currency,
          };
        }
        break;
      }
      case 'obtenerRecomendaciones': {
        if (
          !(await this.persistence.read((r) => r.queries.hasActiveRules(now)))
        ) {
          result = { recommendations: [] };
          break;
        }
        const product = String(q.productoId),
          channel = String(q.canal);
        const origin = await this.facts.recommendationOrigin(
          product,
          channel,
          signal,
          context,
        );
        signal.throwIfAborted();
        if (!origin.active || !origin.channelEligible) {
          result = { recommendations: [] };
          break;
        }
        const rules = await this.persistence.read((r) =>
          r.queries.matchingRules(product, origin.categoryId, now),
        );
        const facts = await this.facts.recommendationProducts(
          [...new Set(rules.flatMap((r) => r.items.map((i) => i.productId)))],
          channel,
          signal,
          context,
        );
        if (rules.some((r) => r.items.some((i) => !facts.has(i.productId))))
          throw new CommercialDependencyError(
            'recomendaciones',
            'Catálogo/Inventario',
            'respuesta completa de elegibilidad/disponibilidad; distinguir ausencia confirmada de fallo técnico',
          );
        const candidates = rules.flatMap((r) =>
          r.items.flatMap((i) => {
            const f = facts.get(i.productId);
            return f
              ? [
                  {
                    productId: i.productId,
                    type: r.recommendationType,
                    priority: r.priority,
                    order: i.itemOrder,
                    ruleId: r.id,
                    ...f,
                  },
                ]
              : [];
          }),
        );
        result = {
          recommendations: rankRecommendations(candidates, product).map(
            (c) => ({
              product_id: c.productId,
              type: c.type,
              rule_priority: c.priority,
              presentation_order: c.order,
              current_price: c.currentPrice,
              availability: c.availability,
            }),
          ),
        };
        break;
      }
      default:
        throw new PromotionsHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    }
    if (!valid(result, contract.response))
      throw new PromotionsHttpError(500, 'ERROR_INTERNO');
    return result;
  }
}
