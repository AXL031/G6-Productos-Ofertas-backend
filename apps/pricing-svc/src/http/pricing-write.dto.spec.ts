import {
  parsePriceScheduleRequest,
  parsePriceUpdateRequest,
} from './pricing-write.dto.js';
import { PricingMutations } from '../application/pricing-mutations.js';
import { changePrice } from '../domain/price.js';

const body = {
  precioRegular: 99.99,
  precioOferta: null,
  accionPrecioOferta: 'ELIMINAR',
  moneda: 'PEN',
  motivoCambio: 'Retiro de oferta',
  priceVersion: 4,
};

describe('Preparación contractual de escrituras, sin exponer mutaciones', () => {
  it('traduce PATCH con versión segura, canal global y oferta null para el caso de uso existente', () => {
    const parsed = parsePriceUpdateRequest(body);
    expect(parsed).toEqual({
      channelId: null,
      expectedVersion: 4n,
      input: {
        precioRegular: '99.99',
        precioOferta: null,
        accionPrecioOferta: 'ELIMINAR',
        currency: 'PEN',
        motivoCambio: 'Retiro de oferta',
      },
    });
    const input: Parameters<PricingMutations['update']>[2] = {
      ...parsed.input,
      usuarioId: null,
    };
    expect(input.precioOferta).toBeNull();
  });

  it.each(['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'])(
    'acepta canal textual %s',
    (channelId) => {
      expect(parsePriceUpdateRequest({ ...body, channelId }).channelId).toBe(
        channelId,
      );
    },
  );
  it.each([
    'OTHER',
    'retail',
    ' RETAIL',
    '74ed2f19-7e70-4915-a6f6-bbc691b82587',
    12,
  ])('rechaza canal no contractual %s', (channelId) => {
    expect(() => parsePriceUpdateRequest({ ...body, channelId })).toThrow(
      'VALIDACION',
    );
    expect(() =>
      parsePriceScheduleRequest({ ...scheduled, channelId }),
    ).toThrow('VALIDACION');
  });
  it('permite conservar el regular omitido y no crea un precio cero', () => {
    const parsed = parsePriceUpdateRequest({ ...body, precioRegular: null });
    expect(parsed.input.precioRegular).toBeUndefined();
  });

  it('conserva el mínimo cero de OpenAPI; el caso de uso decidirá el conflicto de versión', () => {
    expect(
      parsePriceUpdateRequest({ ...body, priceVersion: 0 }).expectedVersion,
    ).toBe(0n);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4', null])(
    'rechaza la versión no reenviable %s',
    (priceVersion) => {
      expect(() => parsePriceUpdateRequest({ ...body, priceVersion })).toThrow(
        'VALIDACION',
      );
    },
  );

  it.each([NaN, Infinity, 1.001, 10000000000, '99.99', 0, -1])(
    'rechaza el importe %s sin redondear',
    (precioRegular) => {
      expect(() =>
        parsePriceUpdateRequest({ ...body, precioRegular }),
      ).toThrow();
    },
  );

  it('exige oferta explícita al establecerla y conserva la validación de dominio', () => {
    expect(() =>
      parsePriceUpdateRequest({ ...body, accionPrecioOferta: 'ESTABLECER' }),
    ).toThrow('ACCION_OFERTA_INVALIDA');
    const parsed = parsePriceUpdateRequest({
      ...body,
      accionPrecioOferta: 'ESTABLECER',
      precioOferta: 100,
    });
    expect(() =>
      changePrice(
        {
          target: { productId: 'producto', sku: null },
          channelId: null,
          priceVersion: 4n,
          validities: [
            {
              precioRegular: '99.99',
              precioOferta: null,
              currency: 'PEN',
              motivoCambio: 'Anterior',
              usuarioId: null,
              validFrom: new Date(0),
              validUntil: null,
              priceVersion: 4n,
              isCancelled: false,
            },
          ],
        },
        { ...parsed.input, usuarioId: null },
        parsed.expectedVersion,
        new Date(),
      ),
    ).toThrow('OFERTA_INVALIDA');
  });

  const scheduled = {
    tipoPrecio: 'OFERTA',
    importe: 80.25,
    moneda: 'PEN',
    channelId: 'RETAIL',
    motivoCambio: 'Oferta programada',
    validFrom: '2030-01-01T10:00:00-05:00',
  };

  it('traduce POST sin inventar una versión de cliente ni el payload Outbox', () => {
    const parsed = parsePriceScheduleRequest(scheduled);
    const input: Parameters<PricingMutations['schedule']>[2] = {
      ...parsed.input,
      usuarioId: null,
    };
    expect(input.importe).toBe('80.25');
    expect(input.validFrom.toISOString()).toBe('2030-01-01T15:00:00.000Z');
    expect(input.validUntil).toBeNull();
    expect(parsed).not.toHaveProperty('expectedVersion');
    expect(parsed).not.toHaveProperty('payload');
  });

  it.each(['2030-02-30T10:00:00Z', '2030-01-01', 'invalid'])(
    'rechaza fecha %s',
    (validFrom) => {
      expect(() =>
        parsePriceScheduleRequest({ ...scheduled, validFrom }),
      ).toThrow('VALIDACION');
    },
  );

  it.each([
    { moneda: 'PE' },
    { motivoCambio: '' },
    { channelId: '' },
    { tipoPrecio: 'OTRO' },
  ])('rechaza campos inválidos %j', (override) => {
    expect(() =>
      parsePriceScheduleRequest({ ...scheduled, ...override }),
    ).toThrow('VALIDACION');
  });
});
