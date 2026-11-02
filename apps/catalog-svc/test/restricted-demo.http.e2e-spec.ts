import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import {
  CATALOG_READ_DEMO,
  readCatalogReadDemo,
} from '../src/catalog-read-demo.js';
import { CatalogMutationService } from '../src/catalog-mutation.service.js';
import {
  CatalogTokenRejected,
  CatalogTokenVerifier,
} from '../src/catalog-auth.js';
import { CatalogQueryRepository } from '../src/catalog-query.repository.js';

// HTTP/guard fixtures only. Real transactions are exercised separately by HTTP-50.
describe.each([false, true])(
  'Restricted demo HTTP access, enabled=%s',
  (restricted) => {
    it('restricts selected operations, strips untrusted credentials and restores JWT when disabled', async () => {
      const create = vi.fn(async (_body: unknown, _actor: unknown) => ({
        product_id: 'fixture',
      }));
      const verify = vi.fn(async () => {
        throw new CatalogTokenRejected();
      });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CATALOG_READ_DEMO)
        .useValue({ enabled: false, restricted, gatewayIps: ['127.0.0.1'] })
        .overrideProvider(CatalogTokenVerifier)
        .useValue({ verify })
        .overrideProvider(CatalogMutationService)
        .useValue({ createProduct: create, update: create, state: create })
        .overrideProvider(CatalogQueryRepository)
        .useValue({
          productPreparation: async () => ({ product_id: 'fixture' }),
        })
        .compile();
      const app = module.createNestApplication({ logger: false });
      await app.init();
      try {
        for (const [method, path] of [
          ['post', '/productos'],
          ['patch', '/productos/p'],
          ['post', '/productos/p/activar'],
        ] as const) {
          await request(app.getHttpServer())
            [method]('/api/v1' + path)
            .send({})
            .expect(restricted ? (path === '/productos' ? 201 : 200) : 401);
        }
        await request(app.getHttpServer())
          .get('/api/v1/productos/p/preparacion')
          .expect(restricted ? 200 : 401);
        await request(app.getHttpServer())
          .post('/api/v1/productos')
          .set('Authorization', 'Bearer untrusted')
          .send({})
          .expect(restricted ? 201 : 401);
        if (restricted) {
          expect(verify).not.toHaveBeenCalled();
          expect(create.mock.calls.at(-1)?.[1]).toMatchObject({
            authorization: '',
          });
          await request(app.getHttpServer())
            .get('/api/v1/productos/p/preparacion')
            .set('X-Correlation-Id', 'invalid')
            .expect(400);
        }
        await request(app.getHttpServer())
          .get('/api/v1/productos/skus/S/contexto')
          .expect(401);
      } finally {
        await app.close();
      }
    });
  },
);

it('requires explicit private Gateway peers and rejects contradictory flags', () => {
  expect(readCatalogReadDemo({}).restricted).toBeUndefined();
  for (const ip of ['', '8.8.8.8', 'not-an-ip'])
    expect(() =>
      readCatalogReadDemo({
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        CATALOG_DEMO_GATEWAY_IPS: ip,
      }),
    ).toThrow();
  expect(() =>
    readCatalogReadDemo({
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      CATALOG_DEMO_GATEWAY_IPS: '10.0.0.5',
      G6_READ_ONLY_DEMO_ENABLED: 'true',
    }),
  ).toThrow();
});

it('rejects a non-allowlisted TCP peer even with forged proxy headers', async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CATALOG_READ_DEMO)
    .useValue({ enabled: false, restricted: true, gatewayIps: ['10.0.0.5'] })
    .compile();
  const app = module.createNestApplication({ logger: false });
  await app.init();
  try {
    await request(app.getHttpServer())
      .post('/api/v1/productos')
      .set('X-Forwarded-For', '10.0.0.5')
      .send({})
      .expect(403);
  } finally {
    await app.close();
  }
});

import {
  CatalogPriceFilter,
  CATALOG_PRICING_IDENTITY,
} from '../src/catalog-price-filter.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';

it.each([false, true])(
  'HTTP monetary filters use G7 only in authenticated mode, demo=%s (HTTP/SQL fixtures)',
  async (restricted) => {
    const authorization = vi.fn(async () => 'Bearer technical-fixture');
    const listCandidates = vi.fn(
      async (_query: unknown, _demo?: boolean, _ids?: string[]) => ({
        items: [],
        pagina: 1,
        tamanio: 20,
        total: 0,
      }),
    );
    const mode = { enabled: false, restricted, gatewayIps: ['127.0.0.1'] };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CATALOG_READ_DEMO)
      .useValue(mode)
      .overrideProvider(CatalogPriceFilter)
      .useValue(
        new CatalogPriceFilter(
          {
            pricingOrigin: 'http://pricing-svc:3002',
            readDemo: mode,
          },
          { authorization },
        ),
      )
      .overrideProvider(CATALOG_PRICING_IDENTITY)
      .useValue({ authorization })
      .overrideProvider(CatalogTokenVerifier)
      .useValue({
        verify: async () => ({
          kind: 'user',
          subject: 'fixture',
          roles: ['GESTOR_COMERCIAL'],
        }),
      })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({
        priceCandidates: async () => [{ productId: 'p', sku: '0001' }],
        listCandidates,
      })
      .compile();
    const app = module.createNestApplication({ logger: false });
    await app.init();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        restricted ? null : 'Bearer technical-fixture',
      );
      return new Response(
        JSON.stringify({
          items: [
            {
              sku: '0001',
              precio_regular: 90,
              precio_oferta: null,
              currency: 'PEN',
              channel_id: null,
              price_version: 1,
              vigencia_id: 'v',
              origen: 'PRODUCTO',
              valid_from: '2020-01-01T00:00:00Z',
              valid_until: null,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const query = request(app.getHttpServer()).get(
        '/api/v1/productos?precioMin=80&precioMax=100',
      );
      if (!restricted) query.set('Authorization', 'Bearer manager');
      await query.expect(200);
      expect(listCandidates.mock.calls[0]?.[2]).toEqual(['p']);
      expect(authorization).toHaveBeenCalledTimes(restricted ? 0 : 1);
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
      const fail = request(app.getHttpServer()).get(
        '/api/v1/productos?precioMin=80',
      );
      if (!restricted) fail.set('Authorization', 'Bearer manager');
      await fail.expect(503);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  },
);
