import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { CATALOG_SECURITY_CONFIG } from '../src/catalog-auth.js';
import {
  CATALOG_MARKETPLACE_PREVIEW,
  CATALOG_READ_DEMO,
} from '../src/catalog-read-demo.js';
import { PostgresCatalogRepository } from '../src/postgres-catalog.repository.js';
import { CommercialService } from '../src/commercial.service.js';
import { CatalogPricingIdentityProvider } from '../src/catalog-pricing-identity.js';

describe('Private Pricing SKU context HTTP contract (local signed RS256/JWKS, isolated repository)', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: 'pricing-context',
    alg: 'RS256',
    use: 'sig',
  };
  const productId = randomUUID();
  let server: Server, origin: string, app: INestApplication;
  const context = {
    sku: '000-Original',
    productId,
    isVariant: false,
    active: true,
    eligible: true,
  };
  const repository = {
    skuContext: vi.fn(async (_sku: string): Promise<typeof context | null> => ({
      ...context,
    })),
  };
  const commercial = { list: vi.fn(), productById: vi.fn() };
  const credentials = { bearer: vi.fn() };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  function token(patch: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      encode({ alg: 'RS256', kid: 'pricing-context' }) +
      '.' +
      encode({
        iss: origin,
        sub: 'modulo-productos',
        tipo: 'servicio',
        aud: ['api-productos'],
        scope: 'catalogo:leer',
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...patch,
      });
    return (
      unsigned +
      '.' +
      sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString(
        'base64url',
      )
    );
  }
  const path = (sku = context.sku) =>
    '/api/v1/productos/skus/' + encodeURIComponent(sku) + '/contexto';
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/discovery')
        res.end(JSON.stringify({ issuer: origin, jwks_uri: origin + '/keys' }));
      else if (req.url === '/keys') res.end(JSON.stringify({ keys: [jwk] }));
      else res.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    origin = 'http://127.0.0.1:' + address.port;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PostgresCatalogRepository)
      .useValue(repository)
      .overrideProvider(CommercialService)
      .useValue(commercial)
      .overrideProvider(CatalogPricingIdentityProvider)
      .useValue(credentials)
      .overrideProvider(CATALOG_SECURITY_CONFIG)
      .useValue({
        issuer: origin,
        discoveryUrl: origin + '/discovery',
        jwksUrl: origin + '/keys',
      })
      // Restricted administrative demo and preview never bypass this technical operation.
      .overrideProvider(CATALOG_READ_DEMO)
      .useValue({ enabled: false, restricted: true, gatewayIps: ['127.0.0.1'] })
      .overrideProvider(CATALOG_MARKETPLACE_PREVIEW)
      .useValue(true)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    repository.skuContext.mockImplementation(async () => ({ ...context }));
  });
  afterEach(() => {
    expect(commercial.list).not.toHaveBeenCalled();
    expect(commercial.productById).not.toHaveBeenCalled();
    expect(credentials.bearer).not.toHaveBeenCalled();
  });
  it('returns exactly the authoritative context with no commercial/pricing recursion', async () => {
    const response = await request(app.getHttpServer())
      .get(path())
      .set('Authorization', 'Bearer ' + token())
      .expect(200);
    expect(response.body).toEqual(context);
    expect(repository.skuContext).toHaveBeenCalledExactlyOnceWith(context.sku);
  });
  it.each([' 000-a/B%2F+?#ñ ', "000-' OR true --", 'variantes'])(
    'decodes an opaque SKU once and preserves its exact value: %s',
    async (sku) => {
      repository.skuContext.mockResolvedValueOnce({ ...context, sku });
      const response = await request(app.getHttpServer())
        .get(path(sku))
        .set('Authorization', 'Bearer ' + token())
        .expect(200);
      expect(response.body.sku).toBe(sku);
      expect(repository.skuContext).toHaveBeenCalledExactlyOnceWith(sku);
    },
  );
  it.each([
    { active: false, eligible: false },
    { active: true, eligible: false },
  ])(
    'returns existing ineligible SKUs with 200 and flags %j',
    async (flags) => {
      repository.skuContext.mockResolvedValueOnce({ ...context, ...flags });
      const response = await request(app.getHttpServer())
        .get(path())
        .set('Authorization', 'Bearer ' + token())
        .expect(200);
      expect(response.body).toEqual({ ...context, ...flags });
    },
  );
  it('distinguishes absence from a technical failure with contractual Problem Details', async () => {
    repository.skuContext.mockResolvedValueOnce(null);
    const missing = await request(app.getHttpServer())
      .get(path())
      .set('Authorization', 'Bearer ' + token())
      .expect('Content-Type', /application\/problem\+json/)
      .expect(404);
    expect(missing.body).toMatchObject({
      status: 404,
      code: 'SKU_NO_ENCONTRADO',
    });
    repository.skuContext.mockRejectedValueOnce(
      new Error('internal database failure'),
    );
    const failure = await request(app.getHttpServer())
      .get(path())
      .set('Authorization', 'Bearer ' + token())
      .expect('Content-Type', /application\/problem\+json/)
      .expect(503);
    expect(failure.body).toMatchObject({
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
    });
    expect(JSON.stringify(failure.body)).not.toContain('internal database');
  });
  it.each([
    ['anonymous', undefined, 401],
    ['malformed', 'invalid', 401],
    ['expired', { exp: 1 }, 401],
    ['wrong issuer', { iss: 'https://untrusted.example' }, 401],
    ['wrong audience', { aud: ['another-api'] }, 401],
    ['missing scope', { scope: 'precios:leer' }, 403],
    ['Marketplace', { sub: 'modulo-marketplace' }, 403],
    ['legacy Pricing identity', { sub: 'modulo-pricing' }, 403],
    [
      'human manager',
      { tipo: 'acceso', sub: randomUUID(), roles: ['GESTOR_COMERCIAL'] },
      403,
    ],
  ] as const)(
    'rejects %s even with demo flags enabled',
    async (_name, claims, status) => {
      const call = request(app.getHttpServer()).get(
        path() + '?canal=MARKETPLACE',
      );
      if (claims !== undefined)
        call.set(
          'Authorization',
          'Bearer ' + (typeof claims === 'string' ? claims : token(claims)),
        );
      const response = await call
        .expect('Content-Type', /application\/problem\+json/)
        .expect(status);
      expect(response.body).toMatchObject({
        status,
        code: status === 401 ? 'TOKEN_INVALIDO' : 'SCOPE_INSUFICIENTE',
      });
      expect(repository.skuContext).not.toHaveBeenCalled();
    },
  );
  it('rejects a valid-looking JWT with an invalid RS256 signature', async () => {
    const valid = token();
    const parts = valid.split('.');
    const signature = Buffer.from(parts[2]!, 'base64url');
    signature[0] ^= 1;
    parts[2] = signature.toString('base64url');
    await request(app.getHttpServer())
      .get(path())
      .set('Authorization', 'Bearer ' + parts.join('.'))
      .expect(401);
    expect(repository.skuContext).not.toHaveBeenCalled();
  });
});
