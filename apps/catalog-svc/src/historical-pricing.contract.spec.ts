import { randomUUID } from 'node:crypto';
import {
  CandidateHistoricalPricingContract,
  readHistoricalPricingContract,
} from './historical-pricing.contract.js';
import { assertCatalogPublication, envelope } from './catalog-messages.js';
import { parseHistoricalSelection } from './historical-recovery.service.js';

describe('Historical Pricing candidate #205 and explicit human currency', () => {
  const context = {
    productId: randomUUID(),
    skuBase: '000-OPAQUE',
    operationId: randomUUID(),
    correlationId: randomUUID(),
    requestId: randomUUID(),
    currency: 'EUR',
  };
  it('emits only the agreed candidate command with authoritative Pricing adoption and original identities', () => {
    const message = new CandidateHistoricalPricingContract().command(context);
    expect(message).toMatchObject({
      schema_version: 1,
      producer: 'catalog-svc',
      kind: 'command',
      name: 'pricing.product.initialization.requested',
      operation_id: context.operationId,
      correlation_id: context.correlationId,
      causation_id: context.requestId,
    });
    expect(message.data).toEqual({
      modalidad: 'RECUPERACION_HISTORICA',
      product_id: context.productId,
      sku_base: context.skuBase,
      moneda: 'EUR',
      channel_id: null,
      motivo_cambio: 'ALTA_PRODUCTO',
    });
    expect(message.message_id).not.toBe(context.operationId);
    expect(() => assertCatalogPublication(message)).not.toThrow();
  });
  it('is absent by default and cannot be enabled in production or by capability alone', () => {
    expect(readHistoricalPricingContract({})).toBeNull();
    expect(
      readHistoricalPricingContract({
        NODE_ENV: 'test',
        CATALOG_HISTORICAL_RECOVERY_ALLOWED_SUBJECTS: randomUUID(),
      }),
    ).toBeNull();
    expect(
      readHistoricalPricingContract({
        NODE_ENV: 'test',
        CATALOG_HISTORICAL_PRICING_CANDIDATE_ENABLED: 'true',
      }),
    ).toBeInstanceOf(CandidateHistoricalPricingContract);
    for (const NODE_ENV of ['production', 'development', undefined])
      expect(() =>
        readHistoricalPricingContract({
          NODE_ENV,
          CATALOG_HISTORICAL_PRICING_CANDIDATE_ENABLED: 'true',
        }),
      ).toThrow();
    expect(() =>
      readHistoricalPricingContract({
        NODE_ENV: 'test',
        CATALOG_HISTORICAL_PRICING_CANDIDATE_ENABLED: 'yes',
      }),
    ).toThrow();
  });
  it.each([
    undefined,
    null,
    'pen',
    'PeN',
    ' PEN',
    'PEN ',
    'PE',
    'PENN',
    'ZZZ',
    123,
  ])('rejects absent or invalid ISO currency %j for Pricing', (moneda) => {
    expect(() =>
      parseHistoricalSelection({
        solicitudId: randomUUID(),
        dependencias: ['PRICING'],
        moneda,
      }),
    ).toThrow();
  });
  it('accepts explicit currencies independently of amount, and never requires currency for Inventory-only', () => {
    for (const moneda of ['PEN', 'USD', 'EUR'])
      expect(
        parseHistoricalSelection({
          solicitudId: randomUUID(),
          dependencias: ['PRICING'],
          moneda,
        }).moneda,
      ).toBe(moneda);
    expect(
      parseHistoricalSelection({
        solicitudId: randomUUID(),
        dependencias: ['INVENTARIO'],
      }),
    ).not.toHaveProperty('moneda');
    expect(() =>
      parseHistoricalSelection({
        solicitudId: randomUUID(),
        dependencias: ['INVENTARIO'],
        moneda: 'USD',
      }),
    ).toThrow();
    expect(() =>
      parseHistoricalSelection({
        solicitudId: randomUUID(),
        dependencias: ['PRICING'],
        moneda: 'USD',
        precio_regular: 10,
      }),
    ).toThrow();
  });
  it('preserves mandatory price for implicit and explicit ALTA_PRODUCTO and rejects unknown modes', () => {
    const data = {
      product_id: context.productId,
      sku_base: context.skuBase,
      moneda: 'EUR',
      channel_id: null,
      motivo_cambio: 'ALTA_PRODUCTO',
    };
    for (const mode of [
      {},
      { modalidad: 'ALTA_PRODUCTO' },
      { modalidad: 'UNKNOWN' },
    ]) {
      expect(() =>
        envelope(
          'pricing.product.initialization.requested',
          { ...data, ...mode },
          context.correlationId,
          context.operationId,
        ),
      ).toThrow();
    }
    for (const mode of [{}, { modalidad: 'ALTA_PRODUCTO' }]) {
      expect(() =>
        envelope(
          'pricing.product.initialization.requested',
          { ...data, ...mode, precio_regular: 12.5 },
          context.correlationId,
          context.operationId,
        ),
      ).not.toThrow();
    }
  });
});
