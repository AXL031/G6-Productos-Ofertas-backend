import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { Database } from '../src/database.js';
import { CatalogConfig } from '../src/config.js';
import { CatalogAmqpRuntime } from '../src/catalog-amqp.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = mkdtempSync(join(tmpdir(), 'catalog-readiness-'));
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
  G6_SECURITY_MODE: 'G7_AUTHENTICATED',
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
  it('keeps liveness healthy while required Catalog reads are unavailable', async () => {
    const read = vi.fn().mockRejectedValue(new Error('fixture SELECT denied'));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: async () => undefined })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({ checkReadinessAccess: read })
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

  it('checks database identity and required Catalog read access without a commercial query', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(new CatalogConfig(validEnv()))],
    })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: verify })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({ checkReadinessAccess: read })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200)
        .expect({ status: 'ready', service: 'catalog-svc' });
      expect(verify).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('fails closed when database identity verification fails', async () => {
    const read = vi.fn();
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(new CatalogConfig(validEnv()))],
    })
      .overrideProvider(Database)
      .useValue({
        verifyIdentity: async () => {
          throw new Error('fixture');
        },
      })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({ checkReadinessAccess: read })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed when required AMQP is unavailable', async () => {
    const read = vi.fn();
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(new CatalogConfig(validEnv()))],
    })
      .overrideProvider(Database)
      .useValue({ verifyIdentity: async () => undefined })
      .overrideProvider(PostgresCatalogRepository)
      .useValue({ checkReadinessAccess: read })
      .overrideProvider(CatalogAmqpRuntime)
      .useValue({ required: true, ready: false })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
