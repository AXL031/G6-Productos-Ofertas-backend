import { NestFactory } from '@nestjs/core';
import { createApplication } from './bootstrap.js';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';
import { CATALOG_TAXONOMY_CONFIG } from './taxonomy-config.js';
import { isCorrelationId } from './correlation.js';
import { CatalogConfig } from './config.js';
import { CATALOG_POSTGRES_CONFIG, Database } from './database.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadinessController as CommercialReadinessController } from './readiness.controller.js';
import { CATALOG_DATABASE, type CatalogDatabase } from './readiness.js';

const directory = mkdtempSync(join(tmpdir(), 'catalog-bootstrap-'));
const certificate = join(directory, 'fixture.crt');
const env = {
  NODE_ENV: 'test',
  CATALOG_SVC_PORT: '3001',
  PGHOST: 'localhost',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGUSER: 'catalog_app',
  PGPASSWORD: 'fixture-secret',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: certificate,
  G6_DATABASE_SCHEMA: 'catalog',
  G6_EXPECTED_ROLE: 'catalog_app',
  G6_CONNECTION_MODE: 'direct',
};
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

describe('bootstrap configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects invalid configuration before creating the application', async () => {
    const create = vi.spyOn(NestFactory, 'create');
    await expect(createApplication({})).rejects.toThrow('Configuracion');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates and starts HTTP with valid config without leaking secrets', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { app, config } = await createApplication(env);
    try {
      await app.listen(0, '127.0.0.1');
      expect(await app.getUrl()).toMatch(/^http:\/\/127.0.0.1:/);
      expect(config.port).toBe(3001);
      await request(await app.getUrl())
        .get('/health/live')
        .set('X-Correlation-Id', '3FA85F64-5717-4562-B3FC-2C963F66AFA6')
        .expect('X-Correlation-Id', '3FA85F64-5717-4562-B3FC-2C963F66AFA6')
        .expect(200);
      const response = await request(await app.getUrl()).get('/health');
      expect(response.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/);
      for (const supplied of [undefined, 'invalid', 'abc-123', '']) {
        for (const path of [
          '/health/live',
          '/api/v1/productos?canal=MARKETPLACE',
        ]) {
          let call = request(await app.getUrl()).get(path);
          if (supplied !== undefined)
            call = call.set('X-Correlation-Id', supplied);
          const result = await call;
          expect(result.status).toBe(
            supplied === undefined
              ? path === '/health/live'
                ? 200
                : 401
              : 400,
          );
          const id = result.headers['x-correlation-id'];
          expect(isCorrelationId(id)).toBe(true);
          if (result.status !== 200) expect(result.body.correlationId).toBe(id);
        }
      }
      const id = '3FA85F64-5717-4562-B3FC-2C963F66AFA6';
      const problem = await request(await app.getUrl())
        .get('/api/v1/productos?canal=MARKETPLACE')
        .set('X-Correlation-Id', id)
        .expect(401);
      expect(problem.headers['x-correlation-id']).toBe(id);
      expect(problem.body.correlationId).toBe(id);
      expect(problem.body.code).toBe('TOKEN_INVALIDO');
      expect(JSON.stringify(output.mock.calls)).not.toContain('fixture-secret');
    } finally {
      await app.close();
    }
  });
});

describe('readiness after integrating master', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['none', 'database', 'commercial'] as const)(
    'requires both database and commercial checks (failure: %s)',
    async (failure) => {
      const database = vi
        .spyOn(Database.prototype, 'verifyIdentity')
        .mockResolvedValue(undefined);
      const commercial = vi.fn().mockImplementation(async () => {
        await database();
        return { status: 'ready', service: 'catalog-svc' };
      });
      if (failure === 'database')
        database.mockRejectedValue(new Error('fixture-database-failure'));
      if (failure === 'commercial')
        commercial.mockRejectedValue(new Error('fixture-commercial-failure'));
      const module = await Test.createTestingModule({
        imports: [AppModule.forRoot(new CatalogConfig(env))],
      })
        .overrideProvider(CommercialReadinessController)
        .useValue({ ready: commercial })
        .compile();
      try {
        const readiness = module.get<CatalogDatabase>(CATALOG_DATABASE);
        expect(module.get(CATALOG_TAXONOMY_CONFIG)).toBe(
          module.get(CatalogConfig).taxonomy,
        );
        expect(module.get(CATALOG_POSTGRES_CONFIG)).toBe(
          module.get(CatalogConfig).database,
        );
        if (failure === 'none')
          await expect(readiness.check()).resolves.toBeUndefined();
        else await expect(readiness.check()).rejects.toThrow();
        expect(database).toHaveBeenCalledTimes(
          failure === 'commercial' ? 0 : 1,
        );
        expect(commercial).toHaveBeenCalledOnce();
      } finally {
        await module.close();
      }
    },
  );
});
