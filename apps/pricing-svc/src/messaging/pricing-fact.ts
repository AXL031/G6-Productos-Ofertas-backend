import { randomUUID } from 'node:crypto';
import { contains, cents, type PriceDefinition } from '../domain/price.js';
import type { PriceFact } from '../application/pricing-mutations.js';

export type PriceWriteOperation =
  | 'actualizarPrecioSku'
  | 'actualizarPrecioBaseProducto'
  | 'programarPrecioSku'
  | 'programarPrecioBaseProducto';

export interface PriceFactMetadata {
  actor: string | null;
  correlationId: string;
  at: Date;
  operation: PriceWriteOperation;
  productId?: string;
  operationId?: string;
}

export interface PricingPriceChangedData {
  target_type: 'PRODUCTO' | 'SKU';
  product_id: string;
  sku: string | null;
  channel_id: string | null;
  currency: string;
  price_type: 'REGULAR' | 'OFERTA';
  previous_price: string | null;
  new_price: string | null;
  operation: 'CREACION' | 'MODIFICACION' | 'RETIRO_OFERTA';
  reason: string;
  price_version: number;
  valid_from: string;
  batch_id: string | null;
  actor: { user_id: string | null; email: string | null; ip: string | null };
}

function canonical(value: string | null): string | null {
  if (value === null) return null;
  const amount = cents(value);
  const whole = amount / 100n;
  const fraction = String(amount % 100n).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function createPricingPriceChangedFacts(
  before: PriceDefinition,
  after: PriceDefinition,
  metadata: PriceFactMetadata,
): PriceFact[] {
  const next = after.validities.find(
    (validity) => validity.priceVersion === after.priceVersion,
  );
  if (!next) throw new Error('Snapshot de precio no encontrado.');
  const beforeAt = new Date(metadata.at.getTime() - 1);
  const previous = before.validities.find((validity) =>
    contains(validity, beforeAt),
  );
  const priceVersion = Number(after.priceVersion);
  if (!Number.isSafeInteger(priceVersion) || priceVersion < 1)
    throw new Error('Versión fuera de precisión contractual.');

  const target = after.target;
  const productId = target.productId ?? metadata.productId;
  if (!productId)
    throw new Error(
      'El contexto autoritativo de Catalog no contiene productId.',
    );
  const operationId = metadata.operationId ?? randomUUID();
  const changed: Array<{
    type: 'REGULAR' | 'OFERTA';
    oldValue: string | null;
    newValue: string | null;
    operation: PricingPriceChangedData['operation'];
  }> = [];

  const previousRegular = canonical(previous?.precioRegular ?? null);
  const nextRegular = canonical(next.precioRegular);
  if (previousRegular !== nextRegular)
    changed.push({
      type: 'REGULAR',
      oldValue: previousRegular,
      newValue: nextRegular,
      operation: previousRegular === null ? 'CREACION' : 'MODIFICACION',
    });

  const previousOffer = canonical(previous?.precioOferta ?? null);
  const nextOffer = canonical(next.precioOferta);
  if (previousOffer !== nextOffer)
    changed.push({
      type: 'OFERTA',
      oldValue: previousOffer,
      newValue: nextOffer,
      operation:
        nextOffer === null
          ? 'RETIRO_OFERTA'
          : previousOffer === null
            ? 'CREACION'
            : 'MODIFICACION',
    });

  return changed.map((component) => ({
    messageId: randomUUID(),
    correlationId: metadata.correlationId,
    causationId: null,
    operationId,
    payload: {
      target_type: target.productId === null ? 'SKU' : 'PRODUCTO',
      product_id: productId,
      sku: target.sku,
      channel_id: after.channelId,
      currency: next.currency,
      price_type: component.type,
      previous_price: component.oldValue,
      new_price: component.newValue,
      operation: component.operation,
      reason: next.motivoCambio,
      price_version: priceVersion,
      valid_from: next.validFrom.toISOString(),
      batch_id: null,
      actor: { user_id: metadata.actor, email: null, ip: null },
    } satisfies PricingPriceChangedData as unknown as Record<string, unknown>,
  }));
}
