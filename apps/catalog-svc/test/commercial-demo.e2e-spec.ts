import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CommercialController } from '../src/commercial.controller.js';
import { CommercialService } from '../src/commercial.service.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import { TaxonomyClient } from '../src/taxonomy.client.js';
import { CatalogConfig } from '../src/config.js';
import { DEMO_PRICING } from '../src/pricing.client.js';
import { CatalogTokenVerifier } from '../src/catalog-auth.js';
import {
  CATALOG_MARKETPLACE_PREVIEW,
  CATALOG_READ_DEMO,
} from '../src/catalog-read-demo.js';

describe('Marketplace demo preview (HTTP fixtures; Pricing is mocked)', () => {
  let app: INestApplication;
  const product = {
    product_id: 'product-1',
    slug: 'fixture',
    name: 'Fixture',
    description: 'Draft product',
    categoria_id: 'cat',
    tipo_producto_id: 'type',
    marca_id: 'brand',
    tiene_variantes: true,
    sku_base: 'BASE',
    images: ['https://images.example.test/item.webp'],
    attributes: [],
    variants: [
      {
        variant_id: 'variant-1',
        sku: 'SKU-1',
        identifying_attributes: [],
        non_identifying_attributes: [],
        images: ['https://images.example.test/variant.webp'],
      },
    ],
  };
  const repository = {
    listDemoCandidates: vi.fn(),
    findDemoCandidateBySlug: vi.fn(),
    listCandidates: vi.fn(),
    findCandidateBySlug: vi.fn(),
  };
  const pricing = { currentPrice: vi.fn() };

  async function start(enabled = true, readDemo = false) {
    app = (
      await Test.createTestingModule({
        controllers: [CommercialController],
        providers: [
          CommercialService,
          { provide: CATALOG_READ_DEMO, useValue: { enabled: readDemo } },
          { provide: CATALOG_MARKETPLACE_PREVIEW, useValue: enabled },
          {
            provide: CatalogTokenVerifier,
            useValue: {
              verify: async () => ({
                kind: 'user',
                subject: 'fixture-user',
                roles: ['GESTOR_COMERCIAL'],
              }),
            },
          },
          { provide: PostgresCatalogRepository, useValue: repository },
          {
            provide: TaxonomyClient,
            useValue: {
              category: vi.fn(),
              brand: async () => ({
                marca_id: 'brand',
                name: 'Brand',
                description: null,
                logo_url: null,
                country_code: null,
              }),
            },
          },
          {
            provide: CatalogConfig,
            useValue: { marketplaceDemoPreview: enabled },
          },
          { provide: DEMO_PRICING, useValue: pricing },
        ],
      }).compile()
    ).createNestApplication();
    await app.init();
  }
  beforeEach(() => {
    vi.clearAllMocks();
    repository.listDemoCandidates.mockResolvedValue([product]);
    repository.findDemoCandidateBySlug.mockResolvedValue(product);
    pricing.currentPrice.mockResolvedValue({
      precio_regular: 69.9,
      precio_oferta: null,
      currency: 'PEN',
    });
  });
  afterEach(async () => app?.close());

  it('allows anonymous preview only for the approved Marketplace reads', async () => {
    await start();
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE')
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/fixture?canal=MARKETPLACE')
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=CHATBOT')
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&canal=CHATBOT')
      .expect(401);
  });

  it('keeps JWT mandatory when preview is disabled', async () => {
    await start(false);
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE')
      .expect(401);
    expect(repository.listCandidates).not.toHaveBeenCalled();
  });

  it('gives the internal read-only demo precedence when both flags are enabled', async () => {
    await start(true, true);
    repository.listCandidates.mockResolvedValue({
      items: [product],
      pagina: 1,
      tamanio: 20,
      total: 1,
    });
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&estado=BORRADOR')
      .expect(200);
    expect(repository.listCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'BORRADOR' }),
      true,
    );
    expect(repository.listDemoCandidates).not.toHaveBeenCalled();
    expect(pricing.currentPrice).not.toHaveBeenCalled();
  });

  it('HTTP list includes a draft with real image fixture and positive Pricing mock; total is after filtering and before pagination', async () => {
    await start();
    repository.listDemoCandidates.mockResolvedValue([
      product,
      {
        ...product,
        product_id: 'product-2',
        name: 'No price',
        images: ['https://images.example.test/2.webp'],
      },
    ]);
    pricing.currentPrice.mockImplementation(async (id: string) =>
      id === 'product-2'
        ? null
        : { precio_regular: 69.9, precio_oferta: null, currency: 'PEN' },
    );
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&pagina=2&tamanio=1')
      .set('Authorization', 'Bearer fixture')
      .expect(200);
    expect(response.body).toMatchObject({
      items: [],
      pagina: 2,
      tamanio: 1,
      total: 1,
    });
    expect(repository.listDemoCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ canal: 'MARKETPLACE' }),
      100,
      undefined,
    );
  });

  it('HTTP detail returns variant SKU, images and price from a Pricing mock', async () => {
    await start();
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/fixture?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(200);
    expect(response.body).toMatchObject({
      product_id: 'product-1',
      images: ['https://images.example.test/item.webp'],
      precio_regular: 69.9,
      precio_oferta: null,
      currency: 'PEN',
      variants: [
        { sku: 'SKU-1', images: ['https://images.example.test/variant.webp'] },
      ],
      marca: { name: 'Brand' },
    });
    expect(response.body).not.toHaveProperty('estado');
  });

  it('serves a draft whose only image belongs to a variant', async () => {
    await start();
    repository.findDemoCandidateBySlug.mockResolvedValue({
      ...product,
      images: ['https://images.example.test/variant.webp'],
    });
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/fixture?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(200);
    expect(response.body.images).toEqual([
      'https://images.example.test/variant.webp',
    ]);
    expect(response.body.variants[0].sku).toBe('SKU-1');
  });

  it('returns 404 for an absent demo slug and 503 for PostgreSQL failure', async () => {
    await start();
    repository.findDemoCandidateBySlug.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/absent?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(404);
    repository.listDemoCandidates.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(503);
  });

  it('preserves strict Marketplace behavior when the demo flag is disabled', async () => {
    await start(false);
    repository.listCandidates.mockResolvedValue({
      items: [],
      pagina: 1,
      tamanio: 20,
      total: 0,
    });
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(200);
    expect(repository.listDemoCandidates).not.toHaveBeenCalled();
    expect(repository.listCandidates).toHaveBeenCalled();
  });

  it('excludes products without images before asking Pricing', async () => {
    await start();
    repository.listDemoCandidates.mockResolvedValue([]);
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(200);
    expect(response.body.total).toBe(0);
    expect(pricing.currentPrice).not.toHaveBeenCalled();
  });

  it('rejects estado in preview instead of returning drafts as matching ACTIVO', async () => {
    await start();
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&estado=ACTIVO')
      .set('Authorization', 'Bearer fixture')
      .expect(400);
    expect(response.body.statusCode).toBe(400);
    expect(repository.listDemoCandidates).not.toHaveBeenCalled();
    expect(pricing.currentPrice).not.toHaveBeenCalled();
  });

  it('maps Pricing outage to 503 and missing detail price to 404', async () => {
    await start();
    pricing.currentPrice.mockRejectedValueOnce(
      new Error('private downstream detail'),
    );
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(503);
    pricing.currentPrice.mockResolvedValueOnce(null);
    await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/fixture?canal=MARKETPLACE')
      .set('Authorization', 'Bearer fixture')
      .expect(404);
  });

  it('uses strict policy for another channel even while demo preview is enabled', async () => {
    await start();
    repository.listCandidates.mockResolvedValue({
      items: [],
      pagina: 1,
      tamanio: 20,
      total: 0,
    });
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=CHATBOT')
      .set('Authorization', 'Bearer fixture')
      .expect(200);
    expect(repository.listDemoCandidates).not.toHaveBeenCalled();
    expect(repository.listCandidates).toHaveBeenCalled();
  });
});
