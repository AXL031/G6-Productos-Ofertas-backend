import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import { CONTRACT_ROUTES } from '../src/routing/contract-routes.js';
import { PHASE1_INTERNAL_READ_ROUTES } from '../src/routing/phase1-internal-read-routes.js';
import { isEligiblePublicRead } from '../src/routing/gateway-public-reads.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';

// This fixture certifies Gateway selection and transport, not upstream business
// responses, PostgreSQL, storage, AMQP, or cloud deployment.
describe('Expanded Phase 1 Gateway HTTP transport', () => {
  const routes = [...CONTRACT_ROUTES, ...PHASE1_INTERNAL_READ_ROUTES].filter(
    isEligiblePublicRead,
  );
  let provider: Server;
  let app: INestApplication;
  const received: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    body: string;
  }> = [];
  beforeAll(async () => {
    provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      const route = routes.find(
        (r) =>
          r.method === req.method &&
          r.path.replace(/[{][^}]+[}]/g, 'fixture') === req.url,
      );
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      const type = route.responses['200'].types[0];
      res.writeHead(200, { 'content-type': type });
      res.end(type === 'application/json' ? '{}' : 'transport fixture');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing provider');
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      GATEWAY_PUBLIC_OPERATION_IDS: routes.map((r) => r.operationId).join(','),
    };
    for (const service of new Set(routes.map((r) => r.service)))
      env['GATEWAY_' + service.replaceAll('-', '_').toUpperCase() + '_URL'] =
        'http://127.0.0.1:' + address.port;
    const settings = readGatewaySettings(env);
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
  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider)
      await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  it('selects 59 GET and six non-mutating POST candidates', () => {
    expect(routes.filter((r) => r.method === 'GET')).toHaveLength(59);
    expect(routes.filter((r) => r.method === 'POST')).toHaveLength(6);
  });
  for (const route of routes)
    it(
      route.operationId + ' forwards anonymously without fabricating identity',
      async () => {
        const path = route.path.replace(/[{][^}]+[}]/g, 'fixture');
        const start = received.length;
        const client = request(app.getHttpServer());
        const call =
          route.method === 'POST'
            ? client.post(path).send({ probe: 'transport-only' })
            : client.get(path);
        await call.expect(200);
        expect(received).toHaveLength(start + 1);
        expect(received.at(-1)).toMatchObject({
          method: route.method,
          url: path,
          authorization: undefined,
          body: route.method === 'POST' ? '{"probe":"transport-only"}' : '',
        });
      },
    );
  it('never forwards anonymous mutations, missing prevalidation or an invalid supplied JWT', async () => {
    const start = received.length;
    await request(app.getHttpServer())
      .post('/api/v1/productos')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/precios/importaciones/prevalidar')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', 'Bearer invalid')
      .expect(503);
    expect(received).toHaveLength(start);
  });
});
