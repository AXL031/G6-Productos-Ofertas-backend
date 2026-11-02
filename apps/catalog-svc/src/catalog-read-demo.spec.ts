import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module.js';
import {
  CATALOG_READ_DEMO,
  readCatalogReadDemo,
  isDemoCatalogImage,
} from './catalog-read-demo.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { TaxonomyClient } from './taxonomy.client.js';

describe('Explicit internal read-only demo (HTTP provider, isolated repositories)', () => {
  let app: INestApplication;
  const product = {
    product_id: 'fixture',
    name: 'Draft fixture',
    sku_base: 'EXPLICIT-SKU',
    images: [],
    attributes: [],
    variants: [],
  };
  const repository = {
    listCandidates: vi.fn(async () => ({
      items: [product],
      pagina: 1,
      tamanio: 20,
      total: 1,
    })),
    findCandidateByProductId: vi.fn(async () => product),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CATALOG_READ_DEMO)
      .useValue({ enabled: true })
      .overrideProvider(PostgresCatalogRepository)
      .useValue(repository)
      .overrideProvider(TaxonomyClient)
      .useValue({ brand: async () => ({ marca_id: 'brand', name: 'Fixture' }) })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  it('is opt-in and rejects invalid flags', () => {
    expect(readCatalogReadDemo({}).enabled).toBe(false);
    expect(
      readCatalogReadDemo({ G6_READ_ONLY_DEMO_ENABLED: 'true' }).enabled,
    ).toBe(true);
    expect(() =>
      readCatalogReadDemo({ G6_READ_ONLY_DEMO_ENABLED: 'yes' }),
    ).toThrow();
  });
  it('does not present legacy placeholders as real product photographs', () => {
    expect(
      isDemoCatalogImage(
        'https://placehold.co/800x800/png?text=Imagen+referencial',
      ),
    ).toBe(false);
    expect(isDemoCatalogImage('javascript:alert(1)')).toBe(false);
    expect(isDemoCatalogImage('https://example.test/actual-product.jpg')).toBe(
      true,
    );
  });
  it('reads drafts without JWT or commercial eligibility and keeps input validation', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&estado=BORRADOR')
      .expect(200);
    expect(repository.listCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'BORRADOR' }),
      true,
    );
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&pagina=0')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=invalid')
      .expect(400);
  });
  it('reads existing detail without fabricating a JWT principal', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/productos/fixture?canal=MARKETPLACE')
      .set('Authorization', 'Bearer ignored-demo-input')
      .expect(200);
    expect(repository.findCandidateByProductId).toHaveBeenCalledWith(
      'fixture',
      'MARKETPLACE',
      true,
    );
  });
  it('rejects writes and keeps unrelated protected reads protected', async () => {
    for (const path of [
      '/api/v1/productos',
      '/api/v1/productos/fixture/activar',
      '/api/v1/productos/fixture/preparacion/reintentar',
    ])
      await request(app.getHttpServer()).post(path).send({}).expect(403);
    await request(app.getHttpServer())
      .patch('/api/v1/productos/fixture')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/productos/fixture/preparacion')
      .expect(401);
    await request(app.getHttpServer()).get('/api/v1/no-demo-route').expect(404);
  });
});
