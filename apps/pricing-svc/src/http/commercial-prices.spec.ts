import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  CommercialPrices,
  channels,
  parseCommercialQuery,
} from './commercial-prices.js';
import type { PricingRepository } from '../persistence/pricing.repository.js';
import * as priceResolution from '../domain/resolve-price.js';
import { PricingReadGuard } from './pricing-read.guard.js';
import { SignedUser } from '../../test/signed-user.js';
describe('Consultas comerciales contractuales', () => {
  it('conserva límite de 100 SKU, canal e instante explícitos', () => {
    expect(
      parseCommercialQuery(
        {
          skus: Array.from({ length: 100 }, (_, i) => 'SKU-' + i).join(','),
          canal: 'RETAIL',
          at: '2026-10-01T00:00:00Z',
        },
        true,
      ).skus,
    ).toHaveLength(100);
  });
  it.each([
    { skus: '' },
    { skus: 'SKU,' },
    { skus: ['SKU'] },
    { skus: Array(101).fill('SKU').join(',') },
    { skus: 'SKU', canal: 'OTHER' },
    { skus: 'SKU', at: '2026-02-30T00:00:00Z' },
    { skus: 'SKU', at: '2026-01-01' },
    { skus: 'SKU', unexpected: 'field' },
  ])('rechaza consulta inválida %j', (query) =>
    expect(() => parseCommercialQuery(query, true)).toThrow(),
  );
});

describe('Serialización del canal efectivo comercial', () => {
  const at = new Date('2030-06-01T00:00:00Z');
  function fixture(channelId: string | null) {
    const validity = {
      id: randomUUID(),
      precioRegular: '12.50',
      precioOferta: null,
      currency: 'PEN',
      motivoCambio: 'fixture',
      usuarioId: null,
      validFrom: new Date('2030-01-01T00:00:00Z'),
      validUntil: null,
      priceVersion: 1n,
      isCancelled: false,
    };
    const definition = {
      target: { productId: 'product', sku: null },
      channelId,
      priceVersion: 1n,
      validities: [validity],
    };
    const readCandidates = vi.fn().mockResolvedValue([definition]);
    const readCandidatesBatch = vi
      .fn()
      .mockImplementation(async (contexts: readonly { sku: string }[]) =>
        contexts.map(({ sku }) => ({ sku, definitions: [definition] })),
      );
    const service = new CommercialPrices(
      { readCandidates, readCandidatesBatch } as unknown as PricingRepository,
      {
        resolve: async (sku) => ({
          sku,
          productId: 'product',
          isVariant: false,
          active: true,
          eligible: true,
        }),
      },
    );
    return { service, definition, validity, readCandidates };
  }
  it.each(channels)(
    'consulta y devuelve el canal canonico %s sin mapping',
    async (channel) => {
      const { service, readCandidates } = fixture(channel);
      const response = await service.sku('sku', channel, at);
      expect(response.channel_id).toBe(channel);
      expect(readCandidates).toHaveBeenCalledWith(
        'product',
        'sku',
        channel,
        at,
      );
    },
  );
  it.each(channels)('aplica fallback global para %s', async (channel) => {
    const { service, readCandidates } = fixture(null);
    const response = await service.sku('sku', channel, at);
    expect(response.channel_id).toBeNull();
    expect(readCandidates).toHaveBeenCalledWith('product', 'sku', channel, at);
  });
  it.each([undefined, 'RETAIL'] as const)(
    'no publica UUID ni convierte inconsistencias en vacío (canal %s)',
    async (channel) => {
      const { service, definition, validity } = fixture(channel ?? null);
      const resolver = vi
        .spyOn(priceResolution, 'resolvePrice')
        .mockReturnValue({
          definition: { ...definition, channelId: randomUUID() },
          validity,
          origen: 'PRODUCTO',
        });
      try {
        for (const operation of [
          () => service.sku('sku', channel, at),
          () => service.batch(['sku'], channel, at),
        ])
          await expect(operation()).rejects.toMatchObject({
            status: 503,
            code: 'SERVICIO_NO_DISPONIBLE',
          });
      } finally {
        resolver.mockRestore();
      }
    },
  );
});
describe('Consulta comercial por lotes', () => {
  const at = new Date('2030-06-01T00:00:00Z');
  it('limita la concurrencia de contexto Catálogo', async () => {
    let active = 0;
    let maximum = 0;
    const resolve = vi.fn(async (sku: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((done) => setTimeout(done, 1));
      active -= 1;
      return {
        sku,
        productId: 'product',
        isVariant: false,
        active: true,
        eligible: true,
      };
    });
    const service = new CommercialPrices(
      {
        readCandidatesBatch: vi.fn().mockResolvedValue([]),
      } as unknown as PricingRepository,
      { resolve },
    );

    await service.batch(
      Array.from({ length: 20 }, (_, index) => `sku-${index}`),
      undefined,
      at,
    );

    expect(resolve).toHaveBeenCalledTimes(20);
    expect(maximum).toBe(8);
  });

  it('agrupa la lectura de Pricing y conserva orden/duplicados del request', async () => {
    const validity = {
      id: randomUUID(),
      precioRegular: '12.50',
      precioOferta: null,
      currency: 'PEN',
      motivoCambio: 'fixture',
      usuarioId: null,
      validFrom: new Date('2030-01-01T00:00:00Z'),
      validUntil: null,
      priceVersion: 3n,
      isCancelled: false,
    };
    const definition = {
      target: { productId: 'product', sku: null },
      channelId: null,
      priceVersion: 3n,
      validities: [validity],
    };
    const resolve = vi.fn(async (sku: string) => ({
      sku,
      productId: 'product',
      isVariant: false,
      active: true,
      eligible: true,
    }));
    const readCandidates = vi.fn();
    const readCandidatesBatch = vi
      .fn()
      .mockImplementation(async (contexts: readonly { sku: string }[]) =>
        contexts.map(({ sku }) => ({ sku, definitions: [definition] })),
      );
    const service = new CommercialPrices(
      { readCandidates, readCandidatesBatch } as unknown as PricingRepository,
      { resolve },
    );

    const result = await service.batch(
      ['sku-a', 'sku-b', 'sku-a'],
      'RETAIL',
      at,
    );

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(readCandidates).not.toHaveBeenCalled();
    expect(readCandidatesBatch).toHaveBeenCalledOnce();
    expect(readCandidatesBatch).toHaveBeenCalledWith(
      [
        { sku: 'sku-a', productId: 'product', context: expect.any(Object) },
        { sku: 'sku-b', productId: 'product', context: expect.any(Object) },
      ],
      'RETAIL',
      at,
    );
    expect(result.items.map((item) => item.sku)).toEqual([
      'sku-a',
      'sku-b',
      'sku-a',
    ]);
  });

  it('omite contextos sin precio y falla ante un error de un SKU', async () => {
    const readCandidatesBatch = vi.fn().mockResolvedValue([]);
    const missing = new CommercialPrices(
      { readCandidatesBatch } as unknown as PricingRepository,
      { resolve: async () => null },
    );
    await expect(missing.batch(['missing'], undefined, at)).resolves.toEqual({
      items: [],
    });
    expect(readCandidatesBatch).toHaveBeenCalledWith([], null, at);

    const failed = new CommercialPrices(
      { readCandidatesBatch } as unknown as PricingRepository,
      {
        resolve: async (sku) => {
          if (sku === 'bad') throw new Error('upstream failure');
          return {
            sku,
            productId: 'product',
            isVariant: false,
            active: true,
            eligible: true,
          };
        },
      },
    );
    await expect(
      failed.batch(['good', 'bad'], undefined, at),
    ).rejects.toMatchObject({ status: 503 });
    expect(readCandidatesBatch).toHaveBeenCalledTimes(1);
  });
});

describe('JWT técnico solo para operationIds comerciales autorizados', () => {
  const identity = new SignedUser();
  let guard: PricingReadGuard;
  beforeAll(async () => {
    await identity.start();
    guard = new PricingReadGuard({
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: 'unused',
      databaseSsl: false,
      auth: { issuer: identity.issuer, jwksUrl: identity.issuer + '/jwks' },
    });
  });
  afterAll(() => identity.stop());
  const token = (extra: Record<string, unknown> = {}) =>
    identity.token({
      tipo: 'servicio',
      sub: 'modulo-marketplace',
      aud: ['api-productos'],
      scope: 'precios:leer',
      roles: undefined,
      jti: undefined,
      iat: undefined,
      ...extra,
    });
  it('admite claims mínimos de servicio y no exige roles humanos', async () => {
    await expect(guard.authorize(token(), true)).resolves.toMatchObject({
      sub: 'modulo-marketplace',
      tipo: 'servicio',
    });
  });
  it('no autoriza el token técnico para una consulta administrativa', async () => {
    await expect(guard.authorize(token(), false)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('autoriza modulo-productos solo con precios:leer en lecturas comerciales', async () => {
    await expect(
      guard.authorize(token({ sub: 'modulo-productos' }), true),
    ).resolves.toMatchObject({ sub: 'modulo-productos', tipo: 'servicio' });
    await expect(
      guard.authorize(token({ sub: 'modulo-productos' }), false),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      guard.authorize(
        token({ sub: 'modulo-productos', scope: 'catalogo:leer' }),
        true,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    [{ aud: 'another-api' }, 401],
    [{ scope: 'catalogo:leer' }, 403],
    [{ sub: 'modulo-ventas' }, 403],
    [{ exp: 1 }, 401],
    [{ iss: 'https://other.invalid' }, 401],
  ] as const)(
    'rechaza audiencia/scope/cliente/firma temporal inválidos: %j',
    async (extra, status) => {
      await expect(guard.authorize(token(extra), true)).rejects.toMatchObject({
        status,
      });
    },
  );
});
