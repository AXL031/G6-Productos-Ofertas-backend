import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import {
  CATALOG_READ_DEMO,
  readCatalogReadDemo,
} from '../src/catalog-read-demo.js';
import { CATALOG_SECURITY_CONFIG } from '../src/catalog-auth.js';
import { CatalogMutationService } from '../src/catalog-mutation.service.js';
import { CatalogQueryRepository } from '../src/catalog-query.repository.js';
import { createJwtFixture } from './support/jwt-fixture.js';

describe.each([
  'PUBLIC_READ_ONLY',
  'SIMULATED_AUTH',
  'G7_AUTHENTICATED',
] as const)('Catalog HTTP authorization mode %s', (securityMode) => {
  it('keeps unapproved reads and writes private and accepts a signed authorized user token', async () => {
    const jwt = createJwtFixture({ kid: 'catalog-phases-fixture' });
    const issuer = await jwt.listenLocalOnly('127.0.0.1', 0);
    const create = vi.fn(async () => ({ product_id: 'fixture' }));
    const update = vi.fn(async () => ({ product_id: 'fixture' }));
    const state = vi.fn(async () => ({ product_id: 'fixture' }));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CATALOG_READ_DEMO)
      .useValue({ enabled: false, securityMode, publicOperations: [] })
      .overrideProvider(CATALOG_SECURITY_CONFIG)
      .useValue(issuer)
      .overrideProvider(CatalogMutationService)
      .useValue({ createProduct: create, update, state })
      .overrideProvider(CatalogQueryRepository)
      .useValue({ productPreparation: async () => ({ product_id: 'fixture' }) })
      .compile();
    const app = module.createNestApplication({ logger: false });
    await app.init();
    try {
      for (const [method, path] of [
        ['post', '/api/v1/productos'],
        ['patch', '/api/v1/productos/p'],
        ['post', '/api/v1/productos/p/activar'],
      ] as const) {
        await request(app.getHttpServer())[method](path).send({}).expect(401);
      }
      await request(app.getHttpServer())
        .get('/api/v1/productos/p/preparacion')
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/productos?canal=MARKETPLACE')
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/productos')
        .set('Authorization', 'Bearer invalid')
        .send({})
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/productos')
        .set(
          'Authorization',
          `Bearer ${jwt.mintProfile({ issuer: issuer.issuer, profile: 'user-lector' })}`,
        )
        .send({})
        .expect(403);
      // The authorized signed actor is admitted to the write use case.
      await request(app.getHttpServer())
        .post('/api/v1/productos')
        .set(
          'Authorization',
          `Bearer ${jwt.mintProfile({ issuer: issuer.issuer, profile: 'user-gestor' })}`,
        )
        .send({})
        .expect(201);
      expect(create).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(state).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await issuer.close();
    }
  });
});

it('rejects attempts to re-enable access through legacy Catalog flags', () => {
  expect(readCatalogReadDemo({}).securityMode).toBe('G7_AUTHENTICATED');
  for (const env of [
    { GATEWAY_DEMO_NO_AUTH_ENABLED: 'true' },
    { G6_READ_ONLY_DEMO_ENABLED: 'true' },
    { CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED: 'true' },
  ])
    expect(() => readCatalogReadDemo(env)).toThrow();
});

it('ignores client supplied IP headers as identity in SIMULATED_AUTH', async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CATALOG_READ_DEMO)
    .useValue({
      enabled: false,
      securityMode: 'SIMULATED_AUTH',
      publicOperations: [],
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  await app.init();
  try {
    await request(app.getHttpServer())
      .post('/api/v1/productos')
      .set('X-Forwarded-For', '10.0.0.5')
      .set('X-Real-IP', '10.0.0.5')
      .send({})
      .expect(401);
  } finally {
    await app.close();
  }
});
