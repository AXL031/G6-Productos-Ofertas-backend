import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  ADMIN_REFERENCES,
  type AdminReferences,
  type AdminReferenceRequest,
  type ActiveAdminReferences,
} from '../domain/admin-references.js';
import { CommercialDependencyError } from '../domain/commercial-context.js';
import {
  assertActiveScopes,
  assertCoupon,
  assertPromotion,
  assertRecommendation,
  PromotionRuleError,
} from '../domain/promotion-rules.js';
import {
  PromotionsPersistence,
  PromotionsPersistenceError,
} from '../infrastructure/persistence/promotions-persistence.js';
import type {
  NewPromotion,
  PromotionScope,
  CombinationPolicy,
  NewCoupon,
  NewRecommendation,
  RecommendationItem,
} from '../infrastructure/persistence/repositories.js';
import type {
  PromotionQueryRow,
  RuleQueryRow,
} from '../infrastructure/persistence/query-repository.js';
import { couponDto, promotionDto, ruleDto } from './query-service.js';
import { httpContracts } from './http-contract.generated.js';
import { isUuid, PromotionsHttpError, valid } from './http-validation.js';

interface PromotionInput {
  nombre?: string;
  tipoDescuento?: string;
  valor?: number;
  modalidad?: string;
  estado?: string;
  validFrom?: string;
  validUntil?: string;
  prioridad?: number;
  canalesHabilitados?: string[];
  alcance?: { productIds?: string[]; skus?: string[] };
  politicaCombinacion?: {
    ofertaPricing: boolean;
    promocionAutomatica: boolean;
    cupon: boolean;
  };
}
interface CouponInput {
  codigo?: string;
  promocionId?: string;
  estado?: string;
  montoMinimo?: number | null;
  maxUsosGlobal?: number | null;
  maxUsosPorCliente?: number | null;
  politicaCancelacion?: string;
}
interface RuleInput {
  nombre?: string;
  tipo?: string;
  origen?: { tipo: string; id: string };
  prioridad?: number;
  estado?: string;
  validFrom?: string;
  validUntil?: string;
  recomendados?: {
    productId: string;
    orden: number;
    criterioSuperioridad?: string | null;
    justificacionComercial?: string | null;
  }[];
}
function promotionInput(body: PromotionInput, previous?: PromotionQueryRow) {
  const p: NewPromotion = {
    name: body.nombre ?? previous?.name ?? missing('PROMOCION_INVALIDA'),
    discountType:
      body.tipoDescuento ??
      previous?.discountType ??
      missing('PROMOCION_INVALIDA'),
    discountValue:
      body.valor === undefined
        ? (previous?.discountValue ?? missing('PROMOCION_INVALIDA'))
        : String(body.valor),
    modality:
      body.modalidad ?? previous?.modality ?? missing('PROMOCION_INVALIDA'),
    state: body.estado ?? previous?.state ?? missing('PROMOCION_INVALIDA'),
    validFrom:
      body.validFrom ??
      (previous ? new Date(previous.validFrom).toISOString() : undefined) ??
      missing('PROMOCION_INVALIDA'),
    validUntil:
      body.validUntil ??
      (previous ? new Date(previous.validUntil).toISOString() : undefined) ??
      missing('PROMOCION_INVALIDA'),
    priority:
      body.prioridad ?? previous?.priority ?? missing('PROMOCION_INVALIDA'),
    enabledChannels:
      body.canalesHabilitados ??
      previous?.enabledChannels ??
      missing('PROMOCION_INVALIDA'),
  };
  const scopes: PromotionScope[] =
    body.alcance === undefined
      ? (previous?.scopes.map(({ productId, sku }) => ({ productId, sku })) ??
        [])
      : [
          ...(body.alcance.productIds ?? []).map((productId) => ({
            productId,
            sku: null,
          })),
          ...(body.alcance.skus ?? []).map((sku) => ({ productId: null, sku })),
        ];
  const policy: CombinationPolicy = body.politicaCombinacion
    ? {
        pricingOffer: body.politicaCombinacion.ofertaPricing,
        automaticPromotion: body.politicaCombinacion.promocionAutomatica,
        coupon: body.politicaCombinacion.cupon,
      }
    : (previous?.policy ?? missing('PROMOCION_INVALIDA'));
  assertPromotion(p, scopes, policy, previous);
  return { p, scopes, policy };
}
function ruleInput(body: RuleInput, previous?: RuleQueryRow) {
  const rule: NewRecommendation = {
    name:
      body.nombre ?? previous?.name ?? missing('REGLA_RECOMENDACION_INVALIDA'),
    recommendationType:
      body.tipo ??
      previous?.recommendationType ??
      missing('REGLA_RECOMENDACION_INVALIDA'),
    originType:
      body.origen?.tipo ??
      previous?.originType ??
      missing('REGLA_RECOMENDACION_INVALIDA'),
    originId:
      body.origen?.id ??
      previous?.originId ??
      missing('REGLA_RECOMENDACION_INVALIDA'),
    priority:
      body.prioridad ??
      previous?.priority ??
      missing('REGLA_RECOMENDACION_INVALIDA'),
    state:
      body.estado ?? previous?.state ?? missing('REGLA_RECOMENDACION_INVALIDA'),
    validFrom:
      body.validFrom ??
      (previous ? new Date(previous.validFrom).toISOString() : undefined) ??
      missing('REGLA_RECOMENDACION_INVALIDA'),
    validUntil:
      body.validUntil ??
      (previous ? new Date(previous.validUntil).toISOString() : undefined) ??
      missing('REGLA_RECOMENDACION_INVALIDA'),
  };
  const items: RecommendationItem[] =
    body.recomendados === undefined
      ? (previous?.items.map(
          ({
            productId,
            itemOrder,
            superiorityCriterion,
            commercialJustification,
          }) => ({
            productId,
            itemOrder,
            superiorityCriterion,
            commercialJustification,
          }),
        ) ?? [])
      : body.recomendados.map((item) => ({
          productId: item.productId,
          itemOrder: item.orden,
          superiorityCriterion: item.criterioSuperioridad ?? null,
          commercialJustification: item.justificacionComercial ?? null,
        }));
  const request = referenceRequest(
    rule.originType === 'PRODUCTO'
      ? [rule.originId, ...items.map((i) => i.productId)]
      : items.map((i) => i.productId),
    [],
    rule.originType === 'CATEGORIA' ? [rule.originId] : [],
  );
  // Validate internal structure before calling an integration boundary.
  assertRecommendation(
    rule,
    items,
    new Set(request.products),
    new Set(request.categories),
  );
  return { rule, items, request };
}
function referenceRequest(
  products: readonly string[],
  skus: readonly string[],
  categories: readonly string[],
): AdminReferenceRequest {
  const ordered = (values: readonly string[]) => [...new Set(values)].sort();
  return {
    products: ordered(products),
    skus: ordered(skus),
    categories: ordered(categories),
  };
}
function scopeRequest(scopes: readonly PromotionScope[]) {
  return referenceRequest(
    scopes.flatMap((s) => (s.productId == null ? [] : [s.productId])),
    scopes.flatMap((s) => (s.sku == null ? [] : [s.sku])),
    [],
  );
}
function unchangedReferences(
  before: AdminReferenceRequest,
  after: AdminReferenceRequest,
) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new CommercialDependencyError(
      'edición concurrente',
      'Promotions',
      'reintentar con las referencias vigentes del agregado',
    );
}
function missing(
  code: ConstructorParameters<typeof PromotionRuleError>[0],
): never {
  throw new PromotionRuleError(code);
}

@Injectable()
export class PromotionsWriteService {
  constructor(
    @Inject(PromotionsPersistence)
    private readonly persistence: PromotionsPersistence,
    @Inject(ADMIN_REFERENCES) private readonly references: AdminReferences,
  ) {}

  private async verify(
    request: AdminReferenceRequest,
  ): Promise<ActiveAdminReferences> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.references.verify(request, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('REFERENCE_TIMEOUT'));
          }, 2500);
        }),
      ]);
    } catch {
      throw new CommercialDependencyError(
        'verificar referencias',
        'Catálogo + integración G6/G7',
        'fuente autorizada disponible con existencia/actividad verificadas',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async execute(id: string, request: Request): Promise<unknown> {
    const contract = httpContracts[id];
    if (contract.body && !valid(request.body, contract.body))
      throw new PromotionsHttpError(400, 'VALIDACION');
    try {
      const result = id.endsWith('Promocion')
        ? await this.promotion(id, request)
        : id.endsWith('Cupon')
          ? await this.coupon(id, request)
          : await this.recommendation(id, request);
      if (!valid(result, contract.response))
        throw new Error('INVALID_WRITE_RESPONSE');
      return result;
    } catch (error) {
      if (error instanceof PromotionRuleError) {
        const status = Object.entries(contract.errors).find(([, codes]) =>
          codes.includes(error.code),
        )?.[0];
        throw new PromotionsHttpError(
          status ? Number(status) : 503,
          status ? error.code : 'SERVICIO_NO_DISPONIBLE',
        );
      }
      if (
        error instanceof PromotionsPersistenceError &&
        error.sqlState === '23505' &&
        id.endsWith('Cupon')
      )
        throw new PromotionsHttpError(409, 'CUPON_DUPLICADO');
      throw error;
    }
  }

  private async promotion(id: string, request: Request) {
    const create = id === 'crearPromocion';
    const key = request.params.promocionId;
    if (!create && !isUuid(key)) missing('PROMOCION_NO_ENCONTRADA');
    if (id === 'desactivarPromocion')
      return this.persistence.transaction(async (r) => {
        await r.promotions.lock(key as string);
        if (!(await r.queries.promotion(key as string)))
          missing('PROMOCION_NO_ENCONTRADA');
        await r.promotions.update(key as string, { state: 'INACTIVO' });
        return promotionDto((await r.queries.promotion(key as string))!);
      });
    const body: PromotionInput =
      id === 'activarPromocion' ? { estado: 'ACTIVO' } : request.body;
    const previous = create
      ? undefined
      : await this.persistence.read((r) => r.queries.promotion(key as string));
    if (!create && !previous) missing('PROMOCION_NO_ENCONTRADA');
    const prepared = promotionInput(body, previous);
    const refs = scopeRequest(prepared.scopes);
    const active = await this.verify(refs); // Never call Catalog while holding a DB lock.
    return this.persistence.transaction(async (r) => {
      if (!create) await r.promotions.lock(key as string);
      const current = create
        ? undefined
        : await r.queries.promotion(key as string);
      if (!create && !current) missing('PROMOCION_NO_ENCONTRADA');
      const next = promotionInput(body, current);
      unchangedReferences(refs, scopeRequest(next.scopes));
      assertActiveScopes(next.scopes, active.products, active.skus);
      const saved = create
        ? await r.promotions.create(next.p, next.scopes, next.policy)
        : await r.promotions.update(key as string, next.p);
      if (
        !create &&
        (body.alcance !== undefined || body.politicaCombinacion !== undefined)
      )
        await r.promotions.replaceConfiguration(
          saved.id,
          next.scopes,
          next.policy,
        );
      return promotionDto((await r.queries.promotion(saved.id))!);
    });
  }

  private async coupon(id: string, request: Request) {
    const create = id === 'crearCupon';
    const key = request.params.cuponId;
    if (!create && !isUuid(key)) missing('CUPON_NO_ENCONTRADO');
    const action = id === 'activarCupon' || id === 'desactivarCupon';
    const body: CouponInput = action
      ? { estado: id === 'activarCupon' ? 'ACTIVO' : 'INACTIVO' }
      : request.body;
    return this.persistence.transaction(async (r) => {
      if (!create) await r.coupons.lock(key as string);
      const current = create
        ? undefined
        : await r.queries.coupon(key as string);
      if (!create && !current) missing('CUPON_NO_ENCONTRADO');
      const next: NewCoupon = {
        code: body.codigo ?? current?.code ?? missing('LIMITE_CUPON_INVALIDO'),
        promotionId:
          body.promocionId ??
          current?.promotionId ??
          missing('LIMITE_CUPON_INVALIDO'),
        state:
          body.estado ?? current?.state ?? missing('LIMITE_CUPON_INVALIDO'),
        minimumAmount:
          body.montoMinimo === undefined
            ? (current?.minimumAmount ?? null)
            : body.montoMinimo === null
              ? null
              : String(body.montoMinimo),
        maxGlobalUses:
          body.maxUsosGlobal === undefined
            ? (current?.maxGlobalUses ?? null)
            : body.maxUsosGlobal,
        maxCustomerUses:
          body.maxUsosPorCliente === undefined
            ? (current?.maxCustomerUses ?? null)
            : body.maxUsosPorCliente,
        cancellationPolicy:
          body.politicaCancelacion ??
          current?.cancellationPolicy ??
          missing('LIMITE_CUPON_INVALIDO'),
      };
      next.code = assertCoupon(next);
      if (!isUuid(next.promotionId)) missing('LIMITE_CUPON_INVALIDO');
      for (const parentId of [
        ...new Set([
          next.promotionId,
          ...(current ? [current.promotionId] : []),
        ]),
      ].sort())
        await r.promotions.lock(parentId);
      const parent = await r.queries.promotion(next.promotionId);
      if (!parent || parent.modality !== 'CUPON')
        missing('LIMITE_CUPON_INVALIDO');
      const duplicate = await r.coupons.findByCode(next.code);
      assertCoupon(next, duplicate?.id, current?.id);
      const saved = create
        ? await r.coupons.create(next)
        : await r.coupons.update(key as string, next);
      return couponDto((await r.queries.coupon(saved.id))!);
    });
  }

  private async recommendation(id: string, request: Request) {
    const create = id === 'crearReglaRecomendacion';
    const key = request.params.reglaId;
    if (!create && !isUuid(key)) missing('REGLA_RECOMENDACION_NO_ENCONTRADA');
    if (id === 'desactivarReglaRecomendacion')
      return this.persistence.transaction(async (r) => {
        await r.recommendations.lock(key as string);
        if (!(await r.queries.rule(key as string)))
          missing('REGLA_RECOMENDACION_NO_ENCONTRADA');
        await r.recommendations.update(key as string, { state: 'INACTIVO' });
        return ruleDto((await r.queries.rule(key as string))!);
      });
    const body: RuleInput =
      id === 'activarReglaRecomendacion' ? { estado: 'ACTIVO' } : request.body;
    const previous = create
      ? undefined
      : await this.persistence.read((r) => r.queries.rule(key as string));
    if (!create && !previous) missing('REGLA_RECOMENDACION_NO_ENCONTRADA');
    const prepared = ruleInput(body, previous);
    const active = await this.verify(prepared.request);
    return this.persistence.transaction(async (r) => {
      if (!create) await r.recommendations.lock(key as string);
      const current = create ? undefined : await r.queries.rule(key as string);
      if (!create && !current) missing('REGLA_RECOMENDACION_NO_ENCONTRADA');
      const next = ruleInput(body, current);
      unchangedReferences(prepared.request, next.request);
      if (next.items.some((item) => !active.products.has(item.productId)))
        missing('PRODUCTO_RECOMENDADO_INVALIDO');
      assertRecommendation(
        next.rule,
        next.items,
        active.products,
        active.categories,
      );
      const saved = create
        ? await r.recommendations.create(next.rule, next.items)
        : await r.recommendations.update(key as string, next.rule);
      if (!create && body.recomendados !== undefined)
        await r.recommendations.replaceItems(saved.id, next.items);
      return ruleDto((await r.queries.rule(saved.id))!);
    });
  }
}
