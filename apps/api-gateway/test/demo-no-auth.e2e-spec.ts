import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';
import { createSignedIdentity } from './support/signed-identity.js';

describe('Gateway security phase selection', () => {
  let provider: Server;
  let providerOrigin: string;
  let calls: Array<{ method: string; url: string; authorization?: string }>;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    provider = createServer((req, res) => {
      calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('No provider address');
    providerOrigin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    calls = [];
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    provider?.closeAllConnections();
    if (provider)
      await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  async function start(
    mode: 'PUBLIC_READ_ONLY' | 'SIMULATED_AUTH' | 'G7_AUTHENTICATED',
  ): Promise<{
    app: INestApplication;
    token: (changes?: Record<string, unknown>) => string;
    key: Record<string, unknown>;
  }> {
    const issuer =
      mode === 'SIMULATED_AUTH'
        ? 'https://simulated.test/issuer'
        : 'https://security.test/issuer';
    const jwksUrl =
      mode === 'SIMULATED_AUTH'
        ? 'https://simulated.test/jwks'
        : 'https://security.test/jwks';
    const settings = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: mode,
      ...(mode === 'PUBLIC_READ_ONLY'
        ? { GATEWAY_PUBLIC_OPERATION_IDS: 'listarProductos' }
        : mode === 'SIMULATED_AUTH'
          ? {
              SIMULATED_AUTH_ISSUER: issuer,
              SIMULATED_AUTH_JWKS_URL: jwksUrl,
            }
          : { AUTH_ISSUER: issuer, AUTH_JWKS_URL: jwksUrl }),
      GATEWAY_CATALOG_SVC_URL: providerOrigin,
    });
    const signed = createSignedIdentity(settings);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === jwksUrl)
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [signed.key] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      return originalFetch(input, init);
    }) as typeof fetch;
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .overrideProvider(GatewayIdentity)
      .useValue(new GatewayIdentity(settings))
      .compile();
    const app = module.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
    return { app, token: signed.token, key: signed.key };
  }

  it('Fase 1 reenvía solo la lectura aprobada y rechaza escrituras anónimas', async () => {
    const { app } = await start('PUBLIC_READ_ONLY');
    try {
      await request(app.getHttpServer()).get('/api/v1/productos').expect(200);
      expect(calls).toEqual([
        { method: 'GET', url: '/api/v1/productos', authorization: undefined },
      ]);
      await request(app.getHttpServer())
        .post('/api/v1/productos')
        .send({})
        .expect(401);
      expect(calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it.each(['SIMULATED_AUTH', 'G7_AUTHENTICATED'] as const)(
    '%s requires a phase-specific signed actor and rejects anonymous access',
    async (mode) => {
      const { app, token } = await start(mode);
      const issuer =
        mode === 'SIMULATED_AUTH'
          ? 'https://simulated.test/issuer'
          : 'https://security.test/issuer';
      try {
        await request(app.getHttpServer()).get('/api/v1/productos').expect(401);
        const bearer = token({
          iss: issuer,
          tipo: 'acceso',
          sub: '11111111-1111-1111-1111-111111111111',
          roles: ['GESTOR_COMERCIAL'],
          aud: 'api-productos',
        });
        const response = await request(app.getHttpServer())
          .get('/api/v1/productos')
          .set('Authorization', `Bearer ${bearer}`)
          .expect(200);
        expect(response.body).toEqual({});
        expect(calls).toHaveLength(1);
        expect(calls[0].authorization).toBe(`Bearer ${bearer}`);
        await request(app.getHttpServer())
          .post('/api/v1/productos')
          .send({})
          .expect(401);
      } finally {
        await app.close();
      }
    },
  );
});
