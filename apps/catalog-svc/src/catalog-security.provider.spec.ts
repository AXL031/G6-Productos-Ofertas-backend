import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module.js';
import {
  CATALOG_SECURITY_CONFIG,
  type CatalogSecurityConfig,
} from './catalog-auth.js';
import { CATALOG_AMQP_SETTINGS } from './catalog-amqp.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { BarcodeRepository } from './barcode.repository.js';

/** HTTP provider regression: actual controller, guard, crypto, discovery/JWKS,
 * parser and persistence failures. No PostgreSQL or React/Gateway E2E claim. */
describe('Marketplace provider security and invalid pagination regression', () => {
  let issuer: Server,
    origin: string,
    app: INestApplication,
    unconfigured: INestApplication;
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'provider',
    alg: 'RS256',
    use: 'sig',
  };
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  function token(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000),
      body =
        encode({ alg: 'RS256', kid: 'provider' }) +
        '.' +
        encode({
          iss: origin,
          sub: 'modulo-marketplace',
          tipo: 'servicio',
          aud: ['api-productos'],
          scope: 'catalogo:leer',
          iat: now,
          exp: now + 600,
          jti: randomUUID(),
          ...overrides,
        });
    return (
      body +
      '.' +
      sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString(
        'base64url',
      )
    );
  }
  async function create(config?: CatalogSecurityConfig) {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CATALOG_SECURITY_CONFIG)
      .useValue(config)
      .overrideProvider(CATALOG_AMQP_SETTINGS)
      .useValue({})
      .compile();
    const server = module.createNestApplication({ logger: false });
    await server.init();
    return server;
  }
  beforeAll(async () => {
    issuer = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/discovery')
        res.end(JSON.stringify({ issuer: origin, jwks_uri: origin + '/keys' }));
      else if (req.url === '/keys') res.end(JSON.stringify({ keys: [key] }));
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    issuer.listen(0, '127.0.0.1');
    await once(issuer, 'listening');
    const address = issuer.address();
    if (!address || typeof address === 'string') throw new Error();
    origin = 'http://127.0.0.1:' + address.port;
    app = await create({
      issuer: origin,
      discoveryUrl: origin + '/discovery',
      jwksUrl: origin + '/keys',
    });
    unconfigured = await create();
  });
  afterAll(async () => {
    await app?.close();
    await unconfigured?.close();
    await new Promise<void>((resolve) => issuer.close(() => resolve()));
  });
  const path = '/api/v1/productos?canal=MARKETPLACE&pagina=0';
  it('reproduces 503 when Catalog has no security configuration, before parsing pagination', async () => {
    const result = await request(unconfigured.getHttpServer())
      .get(path)
      .auth(token(), { type: 'bearer' })
      .expect(503);
    expect(result.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });
  it('returns contractual 400 with a correctly authenticated token and stable correlation', async () => {
    const id = randomUUID();
    const result = await request(app.getHttpServer())
      .get(path)
      .auth(token(), { type: 'bearer' })
      .set('X-Correlation-Id', id)
      .expect(400);
    expect(result.body).toMatchObject({
      code: 'VALIDACION',
      correlationId: id,
    });
    expect(result.headers['x-correlation-id']).toBe(id);
  });
  it('returns VALIDACION for malformed JSON without leaking the parser body', async () => {
    const result = await request(app.getHttpServer())
      .post('/api/v1/productos')
      .auth(
        token({
          tipo: 'acceso',
          sub: randomUUID(),
          roles: ['GESTOR_COMERCIAL'],
        }),
        { type: 'bearer' },
      )
      .set('Content-Type', 'application/json')
      .send('{"private":"broken')
      .expect(400);
    expect(result.body.code).toBe('VALIDACION');
    expect(JSON.stringify(result.body)).not.toContain('private');
  });
  it('keeps 401 without Authorization (including demo upstream), expired JWT and invalid signature', async () => {
    for (const bearer of [
      undefined,
      token({ exp: 1 }),
      token().slice(0, -12) + 'bad-signature',
      token() + '~',
    ]) {
      const call = request(app.getHttpServer()).get(path);
      if (bearer) call.auth(bearer, { type: 'bearer' });
      expect((await call.expect(401)).body.code).toBe('TOKEN_INVALIDO');
    }
  });
  it('keeps scope/client 403 and audience 401 ahead of validation, and valid reads return 503 on persistence failure', async () => {
    for (const claims of [{ scope: 'invalid' }, { sub: 'modulo-ventas' }])
      expect(
        (
          await request(app.getHttpServer())
            .get(path)
            .auth(token(claims), { type: 'bearer' })
            .expect(403)
        ).body.code,
      ).toBe('SCOPE_INSUFICIENTE');
    const wrongAudience = await request(app.getHttpServer())
      .get(path)
      .auth(token({ aud: ['other-api'] }), { type: 'bearer' })
      .expect(401);
    expect(wrongAudience.body.code).toBe('TOKEN_INVALIDO');
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/v1/productos?canal=MARKETPLACE&pagina=1')
          .auth(token(), { type: 'bearer' })
          .expect(503)
      ).body.code,
    ).toBe('SERVICIO_NO_DISPONIBLE');
  });

  it('resolves exact barcode text only for Retail and preserves the contractual 404', async () => {
    const read = vi.spyOn(app.get(BarcodeRepository), 'resolve');
    try {
      read.mockResolvedValueOnce('000-SKU').mockResolvedValueOnce(null);
      const url = '/api/v1/productos/codigos-barras/resolver';
      const success = await request(app.getHttpServer())
        .post(url)
        .auth(token({ sub: 'modulo-retail' }), { type: 'bearer' })
        .send({ codigo_barras: ' 000/ABC ' })
        .expect(200);
      expect(success.body).toEqual({ sku: '000-SKU' });
      expect(read).toHaveBeenCalledWith(' 000/ABC ');
      const absent = await request(app.getHttpServer())
        .post(url)
        .auth(token({ sub: 'modulo-retail' }), { type: 'bearer' })
        .send({ codigo_barras: 'missing' })
        .expect(404);
      expect(absent.body.code).toBe('CODIGO_BARRAS_NO_ENCONTRADO');
      for (const sub of [
        'modulo-marketplace',
        'modulo-chatbot',
        'modulo-ventas',
      ])
        await request(app.getHttpServer())
          .post(url)
          .auth(token({ sub }), { type: 'bearer' })
          .send({ codigo_barras: '0001' })
          .expect(403);
      await request(app.getHttpServer())
        .post(url)
        .send({ codigo_barras: '0001' })
        .expect(401);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
  });

  it('serves an authenticated empty catalog to existing clients and does not authorize Ventas', async () => {
    const read = vi
      .spyOn(app.get(PostgresCatalogRepository), 'listCandidates')
      .mockResolvedValue({ items: [], pagina: 1, tamanio: 20, total: 0 });
    try {
      for (const [sub, canal] of [
        ['modulo-marketplace', 'MARKETPLACE'],
        ['modulo-chatbot', 'CHATBOT'],
        ['modulo-retail', 'RETAIL'],
      ]) {
        const response = await request(app.getHttpServer())
          .get('/api/v1/productos?canal=' + canal)
          .auth(token({ sub }), { type: 'bearer' })
          .expect(200);
        expect(response.body).toEqual({
          items: [],
          pagina: 1,
          tamanio: 20,
          total: 0,
        });
      }
      await request(app.getHttpServer())
        .get('/api/v1/productos?canal=VENTAS')
        .auth(token({ sub: 'modulo-ventas' }), { type: 'bearer' })
        .expect(403);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      read.mockRestore();
    }
  });
});
