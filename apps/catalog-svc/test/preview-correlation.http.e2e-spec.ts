import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CommercialController } from '../src/commercial.controller.js';
import { CommercialService } from '../src/commercial.service.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import { TaxonomyClient } from '../src/taxonomy.client.js';
import { CatalogConfig } from '../src/config.js';
import { DEMO_PRICING, PricingClient } from '../src/pricing.client.js';
import { CatalogTokenVerifier } from '../src/catalog-auth.js';
import { CATALOG_MARKETPLACE_PREVIEW } from '../src/catalog-read-demo.js';

// Real HTTP between Catalog and a local Pricing fixture. No PostgreSQL,
// Gateway, G7 grant, Pricing implementation or Oracle integration is claimed.
describe('Preview correlation to Pricing over real local HTTP (#49)', () => {
  let app: INestApplication, server: Server;
  let status = 200;
  const received: Array<{ correlation: string | undefined; url: string }> = [];
  const products = [1, 2].map((i) => ({
    product_id: `00000000-0000-4000-8000-00000000000${i}`,
    slug: `product-${i}`,
    name: `Product ${i}`,
    description: null,
    categoria_id: 'category',
    tipo_producto_id: 'type',
    marca_id: 'brand',
    tiene_variantes: false,
    sku_base: `000${i}`,
    images: ['https://images.example.test/item.webp'],
    attributes: [],
    variants: [],
  }));

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push({
        correlation: req.headers['x-correlation-id'] as string | undefined,
        url: req.url!,
      });
      res.statusCode = status;
      res.setHeader(
        'content-type',
        status === 404 ? 'application/problem+json' : 'application/json',
      );
      res.end(
        JSON.stringify(
          status === 200
            ? {
                product_id: req.url!.split('/').at(-1),
                precio_regular: 10,
                precio_oferta: null,
                currency: 'PEN',
                channel_id: null,
                price_version: 1,
                valid_from: '2026-01-01T00:00:00.000Z',
                valid_until: null,
              }
            : {
                code: status === 404 ? 'PRECIO_NO_ENCONTRADO' : 'ERROR_INTERNO',
              },
        ),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const config = {
      marketplaceDemoPreview: true,
      pricingOrigin: `http://127.0.0.1:${address.port}`,
    } as CatalogConfig;
    const module = await Test.createTestingModule({
      controllers: [CommercialController],
      providers: [
        CommercialService,
        { provide: CatalogConfig, useValue: config },
        { provide: CATALOG_MARKETPLACE_PREVIEW, useValue: true },
        { provide: CatalogTokenVerifier, useValue: {} },
        { provide: DEMO_PRICING, useValue: new PricingClient(config) },
        {
          provide: PostgresCatalogRepository,
          useValue: {
            listDemoCandidates: async () => products.map((p) => ({ ...p })),
            findDemoCandidateBySlug: async () => products[0],
          },
        },
        {
          provide: TaxonomyClient,
          useValue: {
            brand: async () => ({
              marca_id: 'brand',
              name: 'Brand',
              description: null,
              logo_url: null,
              country_code: null,
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  beforeEach(() => {
    status = 200;
    received.length = 0;
  });
  afterAll(async () => {
    await app?.close();
    if (server?.listening) {
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    }
  });

  it('forwards the same UUID for every candidate before pagination', async () => {
    const id = randomUUID();
    const result = await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&tamanio=1')
      .set('X-Correlation-Id', id)
      .expect(200);
    expect(result.body.total).toBe(2);
    expect(result.body.items).toHaveLength(1);
    expect(received).toEqual(
      products.map((p) => ({
        correlation: id,
        url: `/api/v1/precios/productos/${p.product_id}`,
      })),
    );
  });

  it.each([200, 404, 503])(
    'preserves detail correlation with Pricing HTTP %i',
    async (code) => {
      status = code;
      const id = randomUUID();
      await request(app.getHttpServer())
        .get('/api/v1/productos/por-slug/product-1?canal=MARKETPLACE')
        .set('X-Correlation-Id', id)
        .expect(code);
      expect(received).toEqual([
        {
          correlation: id,
          url: `/api/v1/precios/productos/${products[0].product_id}`,
        },
      ]);
    },
  );

  it('keeps simultaneous request correlations isolated', async () => {
    const ids = [randomUUID(), randomUUID()];
    await Promise.all(
      ids.map((id) =>
        request(app.getHttpServer())
          .get('/api/v1/productos?canal=MARKETPLACE')
          .set('X-Correlation-Id', id)
          .expect(200),
      ),
    );
    for (const id of ids)
      expect(received.filter((call) => call.correlation === id)).toHaveLength(
        2,
      );
    expect(received).toHaveLength(4);
  });
});
