import { resolvePrice } from './resolve-price.js';
import type { PriceDefinition, PriceValidity } from './price.js';

const from = new Date('2030-01-01T00:00:00Z');
const until = new Date('2030-02-01T00:00:00Z');
const context = { productId: 'product', sku: '000123', isVariant: true };
const validity: PriceValidity = {
  precioRegular: '100',
  precioOferta: null,
  currency: 'PEN',
  motivoCambio: 'fixture',
  usuarioId: null,
  validFrom: from,
  validUntil: until,
  priceVersion: 1n,
  isCancelled: false,
};
const product: PriceDefinition = {
  target: { productId: 'product', sku: null },
  channelId: null,
  priceVersion: 2n,
  validities: [validity],
};
const override: PriceDefinition = {
  ...product,
  target: { productId: null, sku: '000123' },
};

describe('SPEC §2 / HU CA-06–07 / DEC-F-001,006: resolución pura', () => {
  it('producto simple se resuelve por productId sin requerir SKU', () => {
    expect(
      resolvePrice(
        [product],
        { productId: 'product', isVariant: false },
        null,
        from,
      ),
    ).toMatchObject({ definition: product, origen: 'PRODUCTO' });
  });
  it('variante requiere SKU y lo usa para buscar el override', () => {
    expect(() =>
      resolvePrice(
        [product],
        { productId: 'product', isVariant: true },
        null,
        from,
      ),
    ).toThrow('SCOPE_PRECIO_INVALIDO');
    expect(
      resolvePrice([override, product], context, null, from).definition,
    ).toBe(override);
  });
  it('simple hereda producto incluso si se le entrega un override de SKU', () => {
    expect(
      resolvePrice(
        [override, product],
        { ...context, isVariant: false },
        null,
        from,
      ),
    ).toMatchObject({ definition: product, origen: 'PRODUCTO' });
  });
  it('variante sin override hereda sin escribir precio sintético', () => {
    const definitions = Object.freeze([Object.freeze(product)]);
    const result = resolvePrice(definitions, context, null, from);
    expect(result.definition).toBe(product);
    expect(result.validity).toBe(validity);
    expect(result.validity.priceVersion).toBe(1n);
    expect(result.definition.priceVersion).toBe(2n);
    expect(definitions).toHaveLength(1);
  });
  it('override aplicable precede producto y canal específico precede global', () => {
    const channelProduct = { ...product, channelId: 'RETAIL' };
    const channelOverride = { ...override, channelId: 'RETAIL' };
    expect(
      resolvePrice(
        [product, channelProduct, override, channelOverride],
        context,
        'RETAIL',
        from,
      ).definition,
    ).toBe(channelOverride);
    expect(
      resolvePrice([product, channelProduct, override], context, 'RETAIL', from)
        .definition,
    ).toBe(override);
    expect(
      resolvePrice([product, channelProduct], context, 'RETAIL', from)
        .definition,
    ).toBe(channelProduct);
  });
  it('canal sin vigencia aplicable cae al global sin usar futuros, cancelados u otro canal', () => {
    const future = {
      ...override,
      channelId: 'RETAIL',
      validities: [{ ...validity, validFrom: until, validUntil: null }],
    };
    const cancelled = {
      ...override,
      validities: [{ ...validity, isCancelled: true }],
    };
    const otherChannel = { ...override, channelId: 'CHATBOT' };
    expect(
      resolvePrice(
        [future, cancelled, otherChannel, product],
        context,
        'RETAIL',
        from,
      ).definition,
    ).toBe(product);
    expect(
      resolvePrice([otherChannel, product], context, null, from).definition,
    ).toBe(product);
  });
  it('límite inicial incluido, final excluido y selección histórica con versión del snapshot', () => {
    expect(resolvePrice([product], context, null, from).validity).toBe(
      validity,
    );
    expect(() => resolvePrice([product], context, null, until)).toThrow(
      'PRECIO_NO_ENCONTRADO',
    );
    expect(() =>
      resolvePrice([product], context, null, new Date(from.getTime() - 1)),
    ).toThrow('PRECIO_NO_ENCONTRADO');
  });
  it('no toma precio de otro producto/SKU ni acepta fecha inválida', () => {
    expect(() =>
      resolvePrice(
        [product, override],
        { ...context, productId: 'other', sku: '123' },
        null,
        from,
      ),
    ).toThrow('PRECIO_NO_ENCONTRADO');
    expect(() => resolvePrice([], context, null, new Date(NaN))).toThrow(
      'VALIDACION',
    );
    expect(() => resolvePrice([], { ...context, sku: '' }, null, from)).toThrow(
      'SCOPE_PRECIO_INVALIDO',
    );
  });
});
