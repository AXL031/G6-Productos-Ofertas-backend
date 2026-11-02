import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { CatalogPricingIdentityProvider } from '../src/catalog-pricing-identity.js';
import {
  CatalogTokenVerifier,
  CATALOG_SECURITY_CONFIG,
} from '../src/catalog-auth.js';
import { CatalogConfig } from '../src/config.js';
import { CatalogPriceFilter } from '../src/catalog-price-filter.js';

describe('Catalog own modulo-productos token via G7 HTTP contract and real local JWKS (not G7 grant evidence)', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: 'own-technical',
    alg: 'RS256',
    use: 'sig',
  };
  let server: Server,
    origin: string,
    provider: CatalogPricingIdentityProvider,
    filter: CatalogPriceFilter;
  let issueStatus = 200,
    priceStatus = 200,
    tokenPatch: Record<string, unknown> = {},
    requests = 0;
  const forms: URLSearchParams[] = [],
    priceBearers: string[] = [];
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  function token() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      encode({ alg: 'RS256', kid: 'own-technical' }) +
      '.' +
      encode({
        iss: origin,
        sub: 'modulo-productos',
        tipo: 'servicio',
        aud: ['api-productos'],
        scope: 'precios:leer',
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...tokenPatch,
      });
    return (
      unsigned +
      '.' +
      sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString(
        'base64url',
      )
    );
  }
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/discovery') {
        res.end(JSON.stringify({ issuer: origin, jwks_uri: origin + '/keys' }));
        return;
      }
      if (req.url === '/keys') {
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url === '/api/v1/auth/token') {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        forms.push(new URLSearchParams(body));
        requests++;
        expect(req.method).toBe('POST');
        expect(req.headers['content-type']).toBe(
          'application/x-www-form-urlencoded',
        );
        res.statusCode = issueStatus;
        res.end(
          JSON.stringify(
            issueStatus === 200
              ? {
                  accessToken: token(),
                  tokenType: 'Bearer',
                  expiresIn: 600,
                  scopes: ['precios:leer'],
                }
              : { code: 'CLIENTE_INVALIDO' },
          ),
        );
        return;
      }
      if (req.url?.startsWith('/api/v1/precios?')) {
        priceBearers.push(String(req.headers.authorization));
        res.statusCode = priceStatus;
        const query = new URL(req.url, origin),
          at = query.searchParams.get('at')!;
        res.end(
          JSON.stringify(
            priceStatus === 200
              ? {
                  items: query.searchParams
                    .get('skus')!
                    .split(',')
                    .map((sku) => ({
                      sku,
                      precio_regular: 120,
                      precio_oferta: 90,
                      currency: 'PEN',
                      channel_id: query.searchParams.get('canal'),
                      valid_from: at,
                      valid_until: null,
                      price_version: 1,
                      vigencia_id: 'fixture',
                      origen: 'PRODUCTO',
                    })),
                }
              : {
                  code:
                    priceStatus === 401
                      ? 'TOKEN_INVALIDO'
                      : 'SCOPE_INSUFICIENTE',
                },
          ),
        );
        return;
      }
      res.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    origin = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(() => {
    issueStatus = 200;
    priceStatus = 200;
    tokenPatch = {};
    requests = 0;
    forms.length = 0;
    priceBearers.length = 0;
    const security = {
      issuer: origin,
      discoveryUrl: origin + '/discovery',
      jwksUrl: origin + '/keys',
    };
    const config = {
      security,
      serviceCredentials: {
        tokenUrl: origin + '/api/v1/auth/token',
        clientSecret: 'isolated-private-secret',
      },
      pricingOrigin: origin,
    } as CatalogConfig;
    provider = new CatalogPricingIdentityProvider(
      config,
      new CatalogTokenVerifier(security),
    );
    filter = new CatalogPriceFilter(config, provider);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const query = {
    canal: 'MARKETPLACE' as const,
    pagina: 1,
    tamanio: 1,
    orden: 'NOMBRE_ASC' as const,
    precioMax: '100',
  };
  it('acquires one own bearer for concurrent batches, verifies RSA/JWKS and caches until expiry', async () => {
    const candidates = Array.from({ length: 201 }, (_, i) => ({
      sku: 'sku-' + i,
      productId: 'parent',
    }));
    expect(await filter.matchingProducts(candidates, query)).toEqual([
      'parent',
    ]);
    expect(requests).toBe(1);
    expect(forms[0].get('client_id')).toBe('modulo-productos');
    expect(forms[0].get('client_secret')).toBe('isolated-private-secret');
    expect(forms[0].get('grant_type')).toBe('client_credentials');
    expect(forms[0].get('scope')).toBe('precios:leer');
    expect(priceBearers).toHaveLength(3);
    expect(new Set(priceBearers).size).toBe(1);
    expect(await provider.authorization(AbortSignal.timeout(1000))).toBe(
      priceBearers[0],
    );
    expect(requests).toBe(1);
  });
  it.each([401, 403, 503])(
    'fails closed on token issuance HTTP %s without caching the failure',
    async (status) => {
      issueStatus = status;
      await expect(
        filter.matchingProducts([{ sku: 'sku', productId: 'p' }], query),
      ).rejects.toMatchObject({ status: 503 });
      expect(priceBearers).toEqual([]);
      issueStatus = 200;
      expect(
        await filter.matchingProducts([{ sku: 'sku', productId: 'p' }], query),
      ).toEqual(['p']);
      expect(requests).toBe(2);
    },
  );
  it.each([
    { scope: 'tokens:introspeccion roles:leer' },
    { sub: 'modulo-marketplace' },
    { tipo: 'acceso' },
    { aud: ['api-seguridad'] },
    { iss: 'https://wrong.example' },
    { exp: 1 },
  ])('rejects a signed token with incompatible claims %j', async (patch) => {
    tokenPatch = patch;
    await expect(
      filter.matchingProducts([{ sku: 'sku', productId: 'p' }], query),
    ).rejects.toMatchObject({ status: 503 });
    expect(priceBearers).toEqual([]);
  });
  it.each([401, 403])(
    'preserves fail-closed behavior when Pricing denies the technical bearer with %s',
    async (status) => {
      priceStatus = status;
      await expect(
        filter.matchingProducts([{ sku: 'sku', productId: 'p' }], query),
      ).rejects.toMatchObject({ status: 503 });
      expect(priceBearers).toHaveLength(1);
    },
  );
  it('injects the configured identity provider without replacing the consumer token', async () => {
    const security = {
      issuer: origin,
      discoveryUrl: origin + '/discovery',
      jwksUrl: origin + '/keys',
    };
    const config = {
      security,
      serviceCredentials: {
        tokenUrl: origin + '/api/v1/auth/token',
        clientSecret: 'isolated-private-secret',
      },
    } as CatalogConfig;
    const module = await Test.createTestingModule({
      providers: [
        CatalogPricingIdentityProvider,
        CatalogTokenVerifier,
        { provide: CatalogConfig, useValue: config },
        { provide: CATALOG_SECURITY_CONFIG, useValue: security },
      ],
    }).compile();
    try {
      expect(
        await module
          .get(CatalogPricingIdentityProvider)
          .authorization(AbortSignal.timeout(2000)),
      ).toMatch(/^Bearer /);
    } finally {
      await module.close();
    }
  });
  it('does not issue a token without secure configuration or for an already aborted caller', async () => {
    const unconfigured = new CatalogPricingIdentityProvider(
      undefined,
      new CatalogTokenVerifier(),
    );
    await expect(
      unconfigured.authorization(AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ status: 503 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.authorization(controller.signal),
    ).rejects.toMatchObject({ status: 503 });
    expect(forms).toEqual([]);
  });
});
