import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PricingSvcModule } from '../src/pricing-svc.module.js';
import { uuid } from '../src/http/pricing-read.guard.js';

// HTTP de Pricing real y proveedor Catalog de fixture; no es integración con Catalog/G7.
describe('Correlación Pricing -> Catalog', () => {
  let app: INestApplication<App>;
  let server: Server;
  const received: string[] = [];
  let status = 200;
  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push(String(req.headers['x-correlation-id']));
      expect(req.headers.authorization).toBeUndefined();
      res.setHeader(
        'content-type',
        status === 200 ? 'application/json' : 'application/problem+json',
      );
      res.statusCode = status;
      const sku = decodeURIComponent(req.url!.split('/').at(-2)!);
      res.end(
        JSON.stringify(
          status === 200
            ? {
                sku,
                productId: 'fixture',
                isVariant: false,
                active: false,
                eligible: false,
              }
            : {
                status,
                code:
                  status === 404
                    ? 'SKU_NO_ENCONTRADO'
                    : 'SERVICIO_NO_DISPONIBLE',
              },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture sin puerto');
    const module = await Test.createTestingModule({
      imports: [
        PricingSvcModule.forRoot({
          NODE_ENV: 'test',
          PORT: '3002',
          DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
          GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
          PRICING_CATALOG_URL: `http://127.0.0.1:${address.port}`,
        }),
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it.each([200, 404, 503])(
    'conserva UUID entrante/generado en single y batch (Catalog %s)',
    async (upstreamStatus) => {
      status = upstreamStatus;
      for (const path of [
        '/api/v1/precios/skus/0001',
        '/api/v1/precios?skus=0001,0002',
      ]) {
        for (const correlation of [randomUUID(), undefined]) {
          received.length = 0;
          const call = request(app.getHttpServer()).get(path);
          if (correlation) call.set('X-Correlation-Id', correlation);
          const response = await call.expect(
            upstreamStatus === 503 ? 503 : path.includes('?') ? 200 : 404,
          );
          const actual = response.headers['x-correlation-id'];
          expect(actual).toMatch(uuid);
          if (correlation) expect(actual).toBe(correlation);
          expect(received.length).toBe(
            upstreamStatus === 503 || !path.includes('?') ? 1 : 2,
          );
          expect(received.every((id) => id === actual)).toBe(true);
          if (response.status !== 200)
            expect(response.body.correlationId).toBe(actual);
        }
      }
    },
  );
  it('rechaza correlación inválida antes de llamar a Catalog', async () => {
    received.length = 0;
    const response = await request(app.getHttpServer())
      .get('/api/v1/precios/skus/0001')
      .set('X-Correlation-Id', 'invalid')
      .expect(400);
    expect(received).toEqual([]);
    expect(response.headers['x-correlation-id']).toMatch(uuid);
  });
});
