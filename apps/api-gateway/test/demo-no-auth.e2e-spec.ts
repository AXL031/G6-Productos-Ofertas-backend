import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { CONTRACT_ROUTES } from '../src/routing/contract-routes.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';

describe('Gateway no-auth demo mode', () => {
  let provider: Server;
  let app: INestApplication;
  let settings: ReturnType<typeof readGatewaySettings>;
  let calls: {
    method: string;
    url: string;
    authorization?: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }[] = [];
  let providerStatus = 200;
  let providerType = 'application/json';

  beforeAll(async () => {
    provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const status = providerStatus;
      providerStatus = 200;
      const type = providerType;
      providerType = 'application/json';
      calls.push({
        method: req.method!,
        url: req.url!,
        authorization: req.headers.authorization,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(status, {
        'content-type': type,
      });
      res.end('{}');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('No test provider address');
    const origin = `http://127.0.0.1:${address.port}`;
    settings = readGatewaySettings({
      GATEWAY_CATALOG_SVC_URL: origin,
      GATEWAY_TAXONOMY_SVC_URL: origin,
      GATEWAY_PRICING_SVC_URL: origin,
      GATEWAY_PRICE_AUDIT_SVC_URL: origin,
      GATEWAY_PROMOTIONS_SVC_URL: origin,
      GATEWAY_INVENTORY_SVC_URL: origin,
      GATEWAY_COMBOS_SVC_URL: origin,
      GATEWAY_BULK_SVC_URL: origin,
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
    });
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .overrideProvider(GatewayIdentity)
      .useValue(new GatewayIdentity(settings))
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    calls = [];
  });

  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider)
      await new Promise<void>((done) => provider.close(() => done()));
  });

  it.each(CONTRACT_ROUTES)(
    '$method $path forwards without requiring or forwarding Authorization',
    async (route) => {
      const routePath = route.path.replace(
        /\{[^}]+\}/g,
        '11111111-1111-1111-1111-111111111111',
      );
      const path = `${routePath}?pagina=1`;
      const success = Object.entries(route.responses).find(
        ([status]) => Number(status) >= 200 && Number(status) < 300,
      )!;
      const status = Number(success[0]);
      providerStatus = status;
      providerType = success[1].types[0] ?? 'application/json';
      const agent = request(app.getHttpServer());
      const methods = {
        GET: agent.get.bind(agent),
        POST: agent.post.bind(agent),
        PATCH: agent.patch.bind(agent),
        PUT: agent.put.bind(agent),
        DELETE: agent.delete.bind(agent),
      };
      const send = methods[route.method as keyof typeof methods](path);
      for (const header of route.headers)
        send.set(
          header.name,
          header.name === 'idempotency-key'
            ? 'isolated-intent-key'
            : header.name === 'x-correlation-id'
              ? '11111111-1111-1111-1111-111111111111'
              : '1',
        );
      if (route.requestTypes.includes('application/json'))
        send.set('Content-Type', 'application/json').send({ fixture: true });
      else if (route.requestTypes.includes('multipart/form-data'))
        send.attach('archivo', Buffer.from('isolated fixture'), 'fixture.bin');

      const response = await send;
      expect(response.status).toBe(status);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: route.method,
        url: path,
        authorization: undefined,
      });
    },
  );

  it('ignores Authorization and client-supplied identity headers on bypass', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE')
      .set('Authorization', 'not-a-jwt')
      .set('X-User-Id', 'forged-user')
      .set('X-Client-Id', 'forged-client')
      .set('X-Scopes', 'admin')
      .set('X-Forwarded-For', '203.0.113.1')
      .set('X-Real-IP', '203.0.113.1');

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBeUndefined();
    for (const name of [
      'x-user-id',
      'x-client-id',
      'x-scopes',
      'x-forwarded-for',
      'x-real-ip',
    ])
      expect(calls[0].headers[name]).toBeUndefined();
  });

  it.each(['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'])(
    'preserves the contractual channel %s through the exact registered operation',
    async (canal) => {
      const response = await request(app.getHttpServer()).get(
        `/api/v1/productos?canal=${canal}`,
      );
      expect(response.status).toBe(200);
      expect(calls[0].url).toBe(`/api/v1/productos?canal=${canal}`);
    },
  );

  it('keeps request validation and exact contract routing active', async () => {
    const missingIdempotency = await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .send({});
    const invalidCorrelation = await request(app.getHttpServer())
      .get('/api/v1/categorias')
      .set('X-Correlation-Id', 'invalid');
    const wrongContentType = await request(app.getHttpServer())
      .post('/api/v1/categorias')
      .set('Idempotency-Key', 'isolated-intent-key')
      .set('Content-Type', 'text/plain')
      .send('invalid');
    const unknown = await request(app.getHttpServer()).get('/not-registered');
    const wrongMethod = await request(app.getHttpServer()).delete(
      '/api/v1/categorias',
    );

    expect(missingIdempotency.status).toBe(400);
    expect(invalidCorrelation.status).toBe(400);
    expect(wrongContentType.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('fails closed when a contractual upstream is not configured', async () => {
    const unavailableSettings = readGatewaySettings({
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
    });
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(unavailableSettings)
      .compile();
    const unavailableApp = module.createNestApplication({ bodyParser: false });
    await unavailableApp.listen(0, '127.0.0.1');
    try {
      const response = await request(unavailableApp.getHttpServer())
        .post('/api/v1/productos')
        .set('Authorization', 'malformed-but-ignored-in-demo')
        .set('Content-Type', 'application/json')
        .send({ fixture: true });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(calls).toHaveLength(0);
    } finally {
      await unavailableApp.close();
    }
  });
});
