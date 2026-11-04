import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BulkSvcModule } from './../src/bulk-svc.module.js';
import {
  BULK_ENVIRONMENT,
  BULK_READINESS_POOL,
  parseBulkEnvironment,
} from './../src/config/bulk-environment.js';
import type { BulkReadinessPool } from './../src/health/bulk-readiness.service.js';

describe('BulkSvcController (e2e)', () => {
  let app: INestApplication<App>;
  let currentPool: BulkReadinessPool | null = null;

  async function start(
    query: (() => Promise<unknown>) | null = async () => undefined,
  ) {
    const pool: BulkReadinessPool | null = query
      ? {
          query: vi.fn(query),
          end: vi.fn().mockResolvedValue(undefined),
          on: vi.fn().mockReturnThis(),
        }
      : null;
    currentPool = pool;
    const config = parseBulkEnvironment({
      NODE_ENV: 'test',
      BULK_SVC_PORT: '3008',
      ...(query
        ? {
            DATABASE_URL:
              'postgresql://bulk:fixture@127.0.0.1:5432/bulk?sslmode=disable',
          }
        : {}),
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [BulkSvcModule],
    })
      .overrideProvider(BULK_ENVIRONMENT)
      .useValue(config)
      .overrideProvider(BULK_READINESS_POOL)
      .useValue(pool)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    return { pool };
  }

  it('keeps liveness 200 when PostgreSQL is absent and readiness 503', async () => {
    await start(null);
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'bulk-svc' });
    const response = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(503);
    expect(response.body).toEqual({ status: 'not_ready', service: 'bulk-svc' });
  });

  it('returns ready only when the PostgreSQL probe succeeds', async () => {
    const { pool } = await start(async () => undefined);
    const response = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(200);
    expect(response.body).toEqual({ status: 'ready', service: 'bulk-svc' });
    expect(pool?.query).toHaveBeenCalledWith(
      'SELECT 1 FROM bulk.batch_jobs LIMIT 0',
    );
  });

  it('sanitizes probe failures and does not add commercial routes', async () => {
    await start(async () => {
      throw new Error('postgres://user:private-password@private-host/db');
    });
    const response = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(503);
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'bulk-svc' });
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-password|private-host|postgres:\/\//,
    );
    await request(app.getHttpServer())
      .get('/carga-masiva/productos')
      .expect(404);
  });

  afterEach(async () => {
    await app?.close();
    if (currentPool) expect(currentPool.end).toHaveBeenCalledOnce();
    currentPool = null;
  });
});
