import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { CONTRACT_ROUTES } from '../src/routing/contract-routes.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { GatewayReadiness } from '../src/routing/gateway-readiness.js';
import { createSignedIdentity } from './support/signed-identity.js';

describe('Gateway forwarding against isolated HTTP providers', () => {
  let provider: Server;
  let app: INestApplication;
  let settings: GatewaySettings;
  let signed: ReturnType<typeof createSignedIdentity>;
  let calls: {
    method: string;
    url: string;
    headers: Record<string, unknown>;
    body: string;
  }[] = [];
  let reply = {
    status: 200,
    type: 'application/json',
    body: '{"items":[]}',
    delay: 0,
    location: '',
    early: false,
  };

  beforeAll(async () => {
    provider = createServer(async (req, res) => {
      if (reply.early) {
        calls.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: '',
        });
        req.resume();
        res.writeHead(reply.status, { 'content-type': reply.type });
        res.end(reply.body);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/health/ready') {
        if (reply.delay)
          await new Promise((done) => setTimeout(done, reply.delay));
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
        return;
      }
      if (reply.delay)
        await new Promise((done) => setTimeout(done, reply.delay));
      res.writeHead(reply.status, {
        'content-type': reply.type,
        'set-cookie': 'private=secret',
        ...(reply.location ? { location: reply.location } : {}),
      });
      res.end(reply.body);
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('No test provider address');
    const origin = `http://127.0.0.1:${address.port}`;
    settings = {
      upstreams: Object.fromEntries(
        CONTRACT_ROUTES.map((r) => [r.service, origin]),
      ),
      timeoutMs: 250,
      readinessPaths: Object.fromEntries(
        CONTRACT_ROUTES.map((route) => [route.service, '/health/ready']),
      ),
      maxBytes: 1024 * 1024,
      publicOperations: CONTRACT_ROUTES.filter((r) => !r.security.length).map(
        (r) => r.operationId,
      ),
      demoNoAuthEnabled: false,
    };
    signed = createSignedIdentity(settings);
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .overrideProvider(GatewayIdentity)
      .useValue(signed.identity)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    calls = [];
    reply = {
      status: 200,
      type: 'application/json',
      body: '{"items":[]}',
      delay: 0,
      location: '',
      early: false,
    };
  });
  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider)
      await new Promise<void>((done) => provider.close(() => done()));
  });

  it.each(CONTRACT_ROUTES)(
    '$method $path routes only its contract operation $operationId',
    async (route) => {
      const path = route.path.replace(
        /\{[^}]+\}/g,
        '11111111-1111-1111-1111-111111111111',
      );
      const success = Object.entries(route.responses).find(
        ([status]) => Number(status) >= 200 && Number(status) < 300,
      )!;
      reply.status = Number(success[0]);
      reply.type = success[1].types[0] ?? 'application/json';
      reply.body =
        reply.type === 'application/json' ? '{}' : 'isolated-provider-content';
      const token =
        route.security.includes('serviceBearer') && route.clients?.length
          ? signed.token({
              sub: route.clients[0],
              scope: route.scope,
              aud: [route.audience],
            })
          : signed.token({
              tipo: 'acceso',
              sub: '11111111-1111-1111-1111-111111111111',
              roles: ['GESTOR_COMERCIAL'],
            });
      const agent = request(app.getHttpServer());
      const methods = {
        GET: agent.get.bind(agent),
        POST: agent.post.bind(agent),
        PATCH: agent.patch.bind(agent),
        PUT: agent.put.bind(agent),
        DELETE: agent.delete.bind(agent),
      };
      const send = methods[route.method as keyof typeof methods](
        path + '?pagina=1',
      );
      send.set('Authorization', `Bearer ${token}`);
      for (const header of route.headers)
        if (header.required)
          send.set(
            header.name,
            header.name === 'idempotency-key' ? 'isolated-intent-key' : '1',
          );
      if (route.requestTypes.includes('application/json'))
        send.set('Content-Type', 'application/json').send({ fixture: true });
      const response = await send;
      if (route.introspection) {
        expect(response.status).toBe(503);
        expect(calls).toHaveLength(0);
        return;
      }
      expect(response.status).toBe(reply.status);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: route.method,
        url: path + '?pagina=1',
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );

  it('preserves the contractual body, correlation and idempotency headers', async () => {
    reply.status = 202;
    const correlation = '11111111-1111-1111-1111-111111111111';
    const response = await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .set(
        'Authorization',
        `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
      )
      .set('X-Correlation-Id', correlation)
      .set('Idempotency-Key', 'stable-intent-123')
      .send({ order_id: 'opaque-order' });
    expect(response.status).toBe(202);
    expect(calls[0].headers).toMatchObject({
      'x-correlation-id': correlation,
      'idempotency-key': 'stable-intent-123',
    });
    expect(JSON.parse(calls[0].body)).toEqual({ order_id: 'opaque-order' });
    expect(response.headers['x-correlation-id']).toBe(correlation);
  });
  it('rejects missing auth, wrong clients, missing idempotency and unknown methods before upstream', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/v1/productos')).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/inventario/reservas')
          .set(
            'Authorization',
            `Bearer ${signed.token({ scope: 'inventario:reservar' })}`,
          )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/inventario/reservas')
          .set(
            'Authorization',
            `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
          )
      ).status,
    ).toBe(400);
    expect(
      (await request(app.getHttpServer()).delete('/api/v1/productos/abc'))
        .status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each(CONTRACT_ROUTES.filter((route) => route.security.length > 0))(
    'keeps protected operation $operationId authenticated when demo is off',
    async (route) => {
      const path = route.path.replace(
        /\{[^}]+\}/g,
        '11111111-1111-1111-1111-111111111111',
      );
      const agent = request(app.getHttpServer());
      const methods = {
        GET: agent.get.bind(agent),
        POST: agent.post.bind(agent),
        PATCH: agent.patch.bind(agent),
        PUT: agent.put.bind(agent),
        DELETE: agent.delete.bind(agent),
      };
      const response =
        await methods[route.method as keyof typeof methods](path);
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    },
  );
  it('preserves stable Problem.code while removing secret-bearing upstream diagnostics', async () => {
    reply = {
      ...reply,
      status: 401,
      type: 'application/problem+json',
      body: JSON.stringify({
        code: 'TOKEN_INVALIDO',
        detail: 'postgresql://user:secret@host',
        stack: 'private',
      }),
    };
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('TOKEN_INVALIDO');
    expect(response.text).not.toMatch(/secret|postgresql|private/);
  });
  it('bounds slow upstream and rejects redirects without sending credentials elsewhere', async () => {
    reply.delay = 500;
    const timed = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(timed.status).toBe(503);
    reply = {
      ...reply,
      delay: 0,
      status: 302,
      location: 'https://untrusted.test/private',
    };
    const redirect = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(redirect.status).toBe(503);
    expect(redirect.headers.location).toBeUndefined();
  });
  it('keeps liveness separate from upstream readiness', async () => {
    reply.status = 503;
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(
      200,
    );
    expect((await app.get(GatewayReadiness).check()).status).toBe('not_ready');
    reply.status = 200;
    reply.body = '{"status":"ready"}';
    expect((await app.get(GatewayReadiness).check()).status).toBe('ready');
    reply.delay = 400;
    expect((await app.get(GatewayReadiness).check()).status).toBe('not_ready');
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(
      200,
    );
    expect(
      (await request(app.getHttpServer()).get('/health/ready')).status,
    ).toBe(404);
  });

  it('preserves local validation/auth errors absent from operation responses (H-01)', async () => {
    const path = '/api/v1/seo/example';
    const rejected = await request(app.getHttpServer())
      .get(path)
      .set('X-Correlation-Id', 'malformed');
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('VALIDACION');
    const previous = settings.publicOperations;
    Object.assign(settings, { publicOperations: [] });
    try {
      const denied = await request(app.getHttpServer()).get(path);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('SCOPE_INSUFICIENTE');
    } finally {
      Object.assign(settings, { publicOperations: previous });
    }
    expect(calls).toHaveLength(0);
  });

  it('preserves local 400 on a read operation with no declared provider 400', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos/por-slug/example')
      .set('Authorization', `Bearer ${signed.token()}`)
      .set('Content-Type', 'text/plain')
      .send('invalid');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDACION');
    expect(calls).toHaveLength(0);
  });

  it('does not trust undeclared provider codes after separating local errors', async () => {
    reply.status = 400;
    reply.type = 'application/problem+json';
    reply.body = '{"code":"PRIVATE_PROVIDER_ERROR","detail":"secret"}';
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('ERROR_INTERNO');
    expect(response.text).not.toContain('secret');
  });

  it('keeps auth before availability and returns controlled 503 when unconfigured', async () => {
    const previous = settings.upstreams;
    Object.assign(settings, { upstreams: {} });
    try {
      const unauthenticated = await request(app.getHttpServer()).get(
        '/api/v1/productos',
      );
      expect(unauthenticated.status).toBe(401);
      const unavailable = await request(app.getHttpServer())
        .get('/api/v1/productos')
        .set('Authorization', `Bearer ${signed.token()}`);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    } finally {
      Object.assign(settings, { upstreams: previous });
    }
    expect(calls).toHaveLength(0);
  });

  it('returns controlled 503 for an enabled upstream refusing connections', async () => {
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const address = closed.address();
    if (!address || typeof address === 'string')
      throw new Error('No closed provider address');
    await new Promise<void>((done) => closed.close(() => done()));
    const previous = settings.upstreams;
    Object.assign(settings, {
      upstreams: {
        ...previous,
        'catalog-svc': `http://127.0.0.1:${address.port}`,
      },
    });
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/productos')
        .set('Authorization', `Bearer ${signed.token()}`);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(response.text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|stack/);
    } finally {
      Object.assign(settings, { upstreams: previous });
    }
    expect(calls).toHaveLength(0);
  });

  it.each(CONTRACT_ROUTES.filter((route) => route.security.length))(
    '$operationId rejects absent and unauthorized identity before calling its provider',
    async (route) => {
      const path = route.path.replace(
        /\{[^}]+\}/g,
        '11111111-1111-1111-1111-111111111111',
      );
      const agent = request(app.getHttpServer());
      const methods = {
        GET: agent.get.bind(agent),
        POST: agent.post.bind(agent),
        PUT: agent.put.bind(agent),
        PATCH: agent.patch.bind(agent),
        DELETE: agent.delete.bind(agent),
      };
      expect(
        (await methods[route.method as keyof typeof methods](path)).status,
      ).toBe(401);
      const token = signed.token({
        tipo: 'acceso',
        sub: '11111111-1111-1111-1111-111111111111',
        roles: [],
      });
      const denied = await methods[route.method as keyof typeof methods](
        path,
      ).set('Authorization', `Bearer ${token}`);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('SCOPE_INSUFICIENTE');
      expect(calls).toHaveLength(0);
    },
  );

  it('forwards multipart bytes without replacing the boundary or parsing business data', async () => {
    reply.status = 202;
    const response = await request(app.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set(
        'Authorization',
        `Bearer ${signed.token({ tipo: 'acceso', sub: '11111111-1111-1111-1111-111111111111', roles: ['GESTOR_COMERCIAL'] })}`,
      )
      .attach(
        'archivo',
        Buffer.from('sku,nombre\nTEST,Zapatilla\n'),
        'fixture.csv',
      );
    expect(response.status).toBe(202);
    expect(calls[0].body).toContain('sku,nombre\nTEST,Zapatilla');
    expect(calls[0].headers['content-type']).toMatch(
      /multipart\/form-data; boundary=/,
    );
  });

  it.each([
    '/api/v1/carga-masiva/productos/importaciones',
    '/api/v1/precios/importaciones/prevalidar',
  ])(
    'streams valid imports above the old 10 MiB prototype cap: %s (H-02)',
    async (path) => {
      const previous = settings.timeoutMs;
      Object.assign(settings, { timeoutMs: 10000 });
      reply.status = path.includes('prevalidar') ? 200 : 202;
      try {
        const file = Buffer.alloc(11 * 1024 * 1024, 97);
        const response = await request(app.getHttpServer())
          .post(path)
          .set(
            'Authorization',
            `Bearer ${signed.token({ tipo: 'acceso', sub: '11111111-1111-1111-1111-111111111111', roles: ['GESTOR_COMERCIAL'] })}`,
          )
          .attach('archivo', file, 'isolated.csv');
        expect(response.status).toBe(reply.status);
        expect(calls).toHaveLength(1);
        expect(Buffer.byteLength(calls[0].body)).toBeGreaterThan(file.length);
        expect(calls[0].body).toContain('filename="isolated.csv"');
      } finally {
        Object.assign(settings, { timeoutMs: previous });
      }
    },
  );

  describe.each([
    {
      operationId: 'crearMarca',
      method: 'post',
      path: '/api/v1/marcas',
      success: 201,
    },
    {
      operationId: 'actualizarMarca',
      method: 'patch',
      path: '/api/v1/marcas/11111111-1111-1111-1111-111111111111',
      success: 200,
    },
  ] as const)(
    '$operationId brand multipart (H-02)',
    ({ method, path, success }) => {
      let previousTimeout: number;
      beforeEach(() => {
        previousTimeout = settings.timeoutMs;
        Object.assign(settings, { timeoutMs: 10000 });
      });
      afterEach(() => Object.assign(settings, { timeoutMs: previousTimeout }));
      const authorized = () =>
        signed.token({
          tipo: 'acceso',
          sub: '11111111-1111-1111-1111-111111111111',
          roles: ['GESTOR_COMERCIAL'],
        });

      it('streams a logo below the SPEC-011 file limit and above the JSON buffer budget', async () => {
        reply.status = success;
        reply.body = JSON.stringify({
          marcaId: '11111111-1111-1111-1111-111111111111',
          nombre: 'Marca deportiva de prueba',
          estado: 'ACTIVO',
          version: 1,
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z',
        });
        const correlationId = '22222222-2222-2222-2222-222222222222';
        const logo = Buffer.alloc(2 * 1024 * 1024, 97);
        const response = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${authorized()}`)
          .set('X-Correlation-Id', correlationId)
          .field('nombre', 'Marca deportiva de prueba')
          .field('version', '1')
          .attach('logo', logo, {
            filename: 'transport-logo.png',
            contentType: 'image/png',
          });
        expect(response.status).toBe(success);
        expect(response.body).toEqual(JSON.parse(reply.body));
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe(method.toUpperCase());
        expect(calls[0].url).toBe(path);
        expect(calls[0].headers['x-correlation-id']).toBe(correlationId);
        expect(calls[0].headers['content-type']).toMatch(
          /multipart\/form-data; boundary=/,
        );
        expect(calls[0].body).toContain(
          'name="logo"; filename="transport-logo.png"',
        );
        expect(calls[0].body.includes(logo.toString('ascii'))).toBe(true);
        expect(response.headers['x-correlation-id']).toBe(correlationId);
      });

      it.each([false, true])(
        'preserves contractual 413 for a logo above the old 10 MiB buffer, early=%s',
        async (early) => {
          reply = {
            ...reply,
            early,
            status: 413,
            type: 'application/problem+json',
            body: '{"code":"LOGO_EXCEDE_LIMITE","status":413,"detail":"private-logo-storage"}',
          };
          const response = await request(app.getHttpServer())
            [method](path)
            .set('Authorization', `Bearer ${authorized()}`)
            .field('nombre', 'Marca deportiva de prueba')
            .field('version', '1')
            .attach(
              'logo',
              Buffer.alloc(11 * 1024 * 1024, 97),
              'oversized.png',
            );
          expect(response.status).toBe(413);
          expect(response.body).toMatchObject({
            status: 413,
            code: 'LOGO_EXCEDE_LIMITE',
          });
          expect(response.headers['content-type']).toContain(
            'application/problem+json',
          );
          expect(response.text).not.toContain('private-logo-storage');
          expect(calls).toHaveLength(1);
          if (!early)
            expect(Buffer.byteLength(calls[0].body)).toBeGreaterThan(
              11 * 1024 * 1024,
            );
        },
      );

      it('does not accept an import-only code as the logo limit error', async () => {
        reply.status = 413;
        reply.type = 'application/problem+json';
        reply.body = '{"code":"ARCHIVO_EXCEDE_LIMITE","detail":"private-code"}';
        const response = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${authorized()}`)
          .field('nombre', 'Marca deportiva de prueba')
          .field('version', '1')
          .attach(
            'logo',
            Buffer.alloc(2 * 1024 * 1024, 97),
            'transport-logo.png',
          );
        expect(response.status).toBe(500);
        expect(response.body.code).toBe('ERROR_INTERNO');
        expect(response.text).not.toContain('private-code');
        expect(calls).toHaveLength(1);
      });

      it('keeps authentication and authorization before forwarding a multipart logo', async () => {
        const unauthenticated = await request(app.getHttpServer())
          [method](path)
          .attach(
            'logo',
            Buffer.alloc(2 * 1024 * 1024, 97),
            'unauthorized.png',
          );
        expect(unauthenticated.status).toBe(401);
        const denied = await request(app.getHttpServer())
          [method](path)
          .set(
            'Authorization',
            `Bearer ${signed.token({ tipo: 'acceso', sub: '11111111-1111-1111-1111-111111111111', roles: [] })}`,
          )
          .attach('logo', Buffer.alloc(2 * 1024 * 1024, 97), 'forbidden.png');
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('SCOPE_INSUFICIENTE');
        expect(calls).toHaveLength(0);
      });
    },
  );

  it.each([false, true])(
    'preserves the provider file limit rejection, early=%s',
    async (early) => {
      reply = {
        ...reply,
        early,
        status: 413,
        type: 'application/problem+json',
        body: '{"code":"ARCHIVO_EXCEDE_LIMITE","detail":"private-storage-secret","status":413}',
      };
      const response = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .set(
          'Authorization',
          `Bearer ${signed.token({ tipo: 'acceso', sub: '11111111-1111-1111-1111-111111111111', roles: ['GESTOR_COMERCIAL'] })}`,
        )
        .attach(
          'archivo',
          Buffer.alloc(2 * 1024 * 1024, 97),
          'provider-limit-fixture.csv',
        );
      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({
        status: 413,
        code: 'ARCHIVO_EXCEDE_LIMITE',
      });
      expect(response.text).not.toContain('private-storage');
      expect(calls).toHaveLength(1);
    },
  );

  it('authenticates large imports before reading or contacting a provider', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .attach('archivo', Buffer.alloc(2 * 1024 * 1024), 'no-auth.csv');
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('keeps the ordinary JSON buffer budget separate from streamed imports', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .set(
        'Authorization',
        `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
      )
      .set('Idempotency-Key', 'oversized-json-fixture')
      .send({ fixture: 'x'.repeat(settings.maxBytes + 1) });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDACION');
    expect(calls).toHaveLength(0);
  });

  it('streams the contractual import report beyond the old global response cap', async () => {
    const previous = settings.timeoutMs;
    Object.assign(settings, { timeoutMs: 10000 });
    reply.type = 'text/csv';
    reply.body = 'a'.repeat(11 * 1024 * 1024);
    try {
      const response = await request(app.getHttpServer())
        .get(
          '/api/v1/carga-masiva/productos/importaciones/11111111-1111-1111-1111-111111111111/reporte',
        )
        .set(
          'Authorization',
          `Bearer ${signed.token({ tipo: 'acceso', sub: '11111111-1111-1111-1111-111111111111', roles: ['GESTOR_COMERCIAL'] })}`,
        );
      expect(response.status).toBe(200);
      expect(response.text.length).toBe(reply.body.length);
    } finally {
      Object.assign(settings, { timeoutMs: previous });
    }
  });

  it('rejects undeclared file response types rather than streaming arbitrary provider content', async () => {
    reply.type = 'text/html';
    reply.body = 'private-provider-html';
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('private-provider');
  });

  it('bounds incomplete incoming bodies without forwarding or hanging indefinitely', async () => {
    const address = app.getHttpServer<Server>().address();
    if (!address || typeof address === 'string')
      throw new Error('No gateway test port');
    const status = await new Promise<number>((resolve, reject) => {
      const client = httpRequest(
        `http://127.0.0.1:${address.port}/api/v1/inventario/reservas`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
            'content-type': 'application/json',
            'content-length': '1000',
            'idempotency-key': 'partial-body-test',
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => {
            resolve(response.statusCode!);
            client.destroy();
          });
        },
      );
      client.once('error', reject);
      client.setTimeout(3000, () => {
        client.destroy();
        reject(new Error('Request deadline exceeded'));
      });
      client.write('{');
    });
    expect(status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
