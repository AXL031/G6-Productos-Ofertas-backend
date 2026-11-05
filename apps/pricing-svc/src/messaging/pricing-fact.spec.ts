import { describe, expect, it } from 'vitest';
import type { PriceDefinition } from '../domain/price.js';
import { createPricingPriceChangedFacts } from './pricing-fact.js';

const at = new Date('2026-11-04T12:00:00.000Z');
const base = (
  regular: string,
  offer: string | null,
  priceVersion = 2n,
  validFrom = new Date(at.getTime() - (priceVersion === 1n ? 60_000 : 0)),
): PriceDefinition => ({
  target: { productId: 'product-1', sku: null },
  channelId: null,
  priceVersion,
  validities: [
    {
      precioRegular: regular,
      precioOferta: offer,
      currency: 'PEN',
      motivoCambio: 'Ajuste comercial',
      usuarioId: '11111111-1111-4111-8111-111111111111',
      validFrom,
      validUntil: null,
      priceVersion,
      isCancelled: false,
    },
  ],
});
const metadata = {
  actor: '11111111-1111-4111-8111-111111111111',
  correlationId: '22222222-2222-4222-8222-222222222222',
  at,
  operation: 'actualizarPrecioBaseProducto' as const,
};

describe('PricingPriceChangedData', () => {
  it('crea un hecho tipado por componente cuando cambian regular y oferta', () => {
    const facts = createPricingPriceChangedFacts(
      base('100.00', '80', 1n),
      base('110', '75.00'),
      metadata,
    );
    expect(facts).toHaveLength(2);
    expect(new Set(facts.map((fact) => fact.messageId)).size).toBe(2);
    expect(new Set(facts.map((fact) => fact.operationId)).size).toBe(1);
    expect(facts.map((fact) => fact.payload)).toEqual([
      {
        target_type: 'PRODUCTO',
        product_id: 'product-1',
        sku: null,
        channel_id: null,
        currency: 'PEN',
        price_type: 'REGULAR',
        previous_price: '100.00',
        new_price: '110.00',
        operation: 'MODIFICACION',
        reason: 'Ajuste comercial',
        price_version: 2,
        valid_from: at.toISOString(),
        batch_id: null,
        actor: { user_id: metadata.actor, email: null, ip: null },
      },
      {
        target_type: 'PRODUCTO',
        product_id: 'product-1',
        sku: null,
        channel_id: null,
        currency: 'PEN',
        price_type: 'OFERTA',
        previous_price: '80.00',
        new_price: '75.00',
        operation: 'MODIFICACION',
        reason: 'Ajuste comercial',
        price_version: 2,
        valid_from: at.toISOString(),
        batch_id: null,
        actor: { user_id: metadata.actor, email: null, ip: null },
      },
    ]);
  });

  it('omite hechos sin transición de precio efectiva', () => {
    expect(
      createPricingPriceChangedFacts(
        base('100', '80', 1n),
        base('100.00', '80.00'),
        metadata,
      ),
    ).toEqual([]);
  });

  it('representa creación y retiro de oferta sin inventar valores anteriores', () => {
    const created = createPricingPriceChangedFacts(
      base('100', null, 1n),
      base('100', '80'),
      metadata,
    );
    expect(created).toHaveLength(1);
    expect(created[0].payload).toMatchObject({
      price_type: 'OFERTA',
      previous_price: null,
      new_price: '80.00',
      operation: 'CREACION',
    });

    const removed = createPricingPriceChangedFacts(
      base('100', '80', 1n),
      base('100', null),
      metadata,
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      price_type: 'OFERTA',
      previous_price: '80.00',
      new_price: null,
      operation: 'RETIRO_OFERTA',
    });
  });
});
