import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { Database } from '../src/database.js';
import { CatalogConfig } from '../src/config.js';
import { CommercialService } from '../src/commercial.service.js';
import { PricingClient } from '../src/pricing.client.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = mkdtempSync(join(tmpdir(), 'catalog-ready-demo-'));
const certificate = join(directory, 'fixture.crt');
const validEnv = () => ({
  NODE_ENV: 'test',
  CATALOG_SVC_PORT: '3001',
  PGHOST: 'localhost',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGUSER: 'catalog_app',
  PGPASSWORD: 'fixture-secret',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: certificate,
  G6_CONNECTION_MODE: 'direct',
  G6_DATABASE_SCHEMA: 'catalog',
  G6_EXPECTED_ROLE: 'catalog_app',
  CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED: 'true',
  CATALOG_PRICING_URL: 'http://pricing-svc:3002',
});

beforeAll(() =>
  writeFileSync(
    certificate,
    '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----',
  ),
);
afterAll(() => {
  unlinkSync(certificate);
  rmdirSync(directory);
});

describe('Catalog readiness versus liveness', () => {
  it('keeps commercial readiness closed with reachable PostgreSQL but no eligibility source', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: async () => undefined })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/health').expect(200);
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    } finally {
      await app.close();
    }
  });

  it('checks Pricing once in demo readiness without running the commercial list', async () => {
    const list = vi.fn();
    const pricing = vi.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(new CatalogConfig(validEnv()))],
    })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: async () => undefined })
      .overrideProvider(CommercialService)
      .useValue({ list })
      .overrideProvider(PricingClient)
      .useValue({ checkReady: pricing })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({ checkDemoReadAccess: vi.fn().mockResolvedValue(undefined) })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200)
        .expect({ status: 'ready', service: 'catalog-svc' });
      expect(pricing).toHaveBeenCalledOnce();
      expect(list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('keeps demo readiness closed when Pricing fails', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(new CatalogConfig(validEnv()))],
    })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: async () => undefined })
      .overrideProvider(PricingClient)
      .useValue({
        checkReady: async () => {
          throw new Error('fixture');
        },
      })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({ checkDemoReadAccess: vi.fn().mockResolvedValue(undefined) })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    } finally {
      await app.close();
    }
  });

  it('keeps demo readiness closed when a Catalog table SELECT fails', async () => {
    const pricing = vi.fn();
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(new CatalogConfig(validEnv()))],
    })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: async () => undefined })
      .overrideProvider(PricingClient)
      .useValue({ checkReady: pricing })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({
        checkDemoReadAccess: async () => {
          throw new Error('fixture SELECT denied');
        },
      })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(pricing).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
