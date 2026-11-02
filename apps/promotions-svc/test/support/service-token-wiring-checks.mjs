// Real Nest factories, HTTP and disposable PostgreSQL. Only G7 and upstream
// business facts are explicit fixtures; token/identity/commercial providers stay real.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import { PromotionsSvcModule } from '../../../../dist/apps/promotions-svc/promotions-svc.module.js';
import { PromotionsConfigService } from '../../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import { COUPON_RESOURCES } from '../../../../dist/apps/promotions-svc/coupons/coupon-providers.js';

export async function verifyServiceTokenWiring(resources, baseConfig) {
  const issuer = 'https://g7.module.fixture/api/v1/auth';
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'module-fixture',
    alg: 'RS256',
    use: 'sig',
  };
  const jwt = (claims) => {
    const now = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid: jwk.kid },
      {
        iss: issuer,
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...claims,
      },
    ].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'));
    return (
      parts.join('.') +
      '.' +
      sign(
        'RSA-SHA256',
        Buffer.from(parts.join('.')),
        pair.privateKey,
      ).toString('base64url')
    );
  };
  const user = jwt({
    sub: randomUUID(),
    tipo: 'acceso',
    roles: ['GESTOR_COMERCIAL'],
  });
  const incoming = jwt({
    sub: 'modulo-marketplace',
    tipo: 'servicio',
    aud: ['api-productos'],
    scope: 'promociones:evaluar',
  });
  const issued = new Map(),
    requests = new Map(),
    received = [];
  let denyGrant = false;
  const nativeFetch = globalThis.fetch;
  const server = createServer((req, res) => {
    const scope = req.url.startsWith('/api/v1/precios/')
      ? 'precios:leer'
      : 'catalogo:leer';
    received.push({
      path: req.url,
      authorization: req.headers.authorization,
      scope,
    });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ' + issued.get(scope)) {
      res.statusCode = 403;
      res.end('{}');
      return;
    }
    const body = req.url.includes('/contexto')
      ? {
          sku: 'WIRING-SKU',
          productId: 'WIRING-P',
          isVariant: false,
          active: true,
          eligible: true,
        }
      : req.url.includes('/precios/')
        ? {
            sku: 'WIRING-SKU',
            precio_regular: 100,
            precio_oferta: 80,
            currency: 'PEN',
            channel_id: null,
            valid_from: '2026-01-01T00:00:00Z',
            valid_until: null,
            price_version: 1,
            vigencia_id: 'WIRING-V',
            origen: 'PRODUCTO',
          }
        : {
            product_id: 'WIRING-P',
            name: 'Fixture',
            slug: 'fixture',
            categoria_id: 'WIRING-C',
            marca_id: 'M',
            tipo_producto_id: 'T',
            tiene_variantes: false,
            sku_base: 'WIRING-SKU',
            marca: { marca_id: 'M', name: 'M' },
            variants: [],
          };
    res.end(JSON.stringify(body));
  });
  let app;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const upstream = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = async (url, options) => {
      if (String(url) === issuer + '/.well-known/jwks.json')
        return Response.json({ keys: [jwk] });
      if (String(url) === issuer + '/token') {
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('client_id'), 'modulo-productos');
        assert.equal(form.get('client_secret'), 'synthetic-wiring-secret');
        const scope = form.get('scope');
        assert.ok(['catalogo:leer', 'precios:leer'].includes(scope));
        requests.set(scope, (requests.get(scope) ?? 0) + 1);
        if (denyGrant)
          return Response.json({ code: 'fixture-denied' }, { status: 401 });
        const accessToken = jwt({
          sub: 'modulo-productos',
          tipo: 'servicio',
          aud: ['api-productos'],
          scope,
        });
        issued.set(scope, accessToken);
        return Response.json({
          accessToken,
          tokenType: 'Bearer',
          expiresIn: 600,
          scopes: [scope],
        });
      }
      return nativeFetch(url, options);
    };
    const start = async () => {
      const module = await Test.createTestingModule({
        imports: [PromotionsSvcModule],
      })
        .overrideProvider(PromotionsConfigService)
        .useValue(
          new PromotionsConfigService({
            ...baseConfig.settings,
            localDemoEnabled: false,
            auth: { issuer, jwksUrl: issuer + '/.well-known/jwks.json' },
            serviceCredentials: {
              tokenUrl: issuer + '/token',
              clientSecret: 'synthetic-wiring-secret',
            },
            upstreams: {
              catalog: upstream,
              pricing: upstream,
              inventory: upstream,
              taxonomy: upstream,
            },
          }),
        )
        .overrideProvider(COUPON_RESOURCES)
        .useValue({
          ...resources,
          onApplicationShutdown: async () => undefined,
        })
        .compile();
      app = module.createNestApplication({ logger: false });
      await app.listen(0, '127.0.0.1');
      return app.getUrl();
    };
    const snapshot = () =>
      resources.pool.query(
        'SELECT (SELECT count(*)::int FROM promotions.coupon_uses) AS uses, (SELECT count(*)::int FROM promotions.coupon_command_receipts) AS receipts, (SELECT count(*)::int FROM promotions.inbox) AS inbox, (SELECT count(*)::int FROM promotions.outbox) AS outbox',
      );
    const before = await snapshot();
    const call = async (base, bearer = incoming) =>
      nativeFetch(base + '/api/v1/promociones/evaluar', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + bearer,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          channel_id: 'MARKETPLACE',
          lines: [{ sku: 'WIRING-SKU', quantity: 1 }],
        }),
        signal: AbortSignal.timeout(9000),
      });
    const base = await start();
    for (let i = 0; i < 2; i++) {
      const result = await call(base);
      const body = await result.json();
      assert.equal(result.status, 200, JSON.stringify(body));
      assert.equal(body.result_amount, 80);
      assert.equal(body.promotion_id, null);
    }
    assert.equal(requests.get('catalogo:leer'), 1);
    assert.equal(requests.get('precios:leer'), 1);
    assert.ok(received.some((r) => r.path.includes('/contexto')));
    assert.ok(received.some((r) => r.scope === 'precios:leer'));
    assert.ok(
      received.every(
        (r) => r.authorization === 'Bearer ' + issued.get(r.scope),
      ),
    );
    assert.ok(received.every((r) => r.authorization !== 'Bearer ' + user));
    assert.ok(received.every((r) => r.authorization !== 'Bearer ' + incoming));
    const wrongActor = await call(base, user);
    assert.equal(wrongActor.status, 403);
    await wrongActor.body?.cancel();
    const rejected = await call(base, 'invalid');
    assert.equal(rejected.status, 401);
    await rejected.body?.cancel();
    await app.close();
    app = undefined;
    denyGrant = true;
    const count = received.length;
    const unavailable = await call(await start());
    const problem = await unavailable.json();
    assert.equal(unavailable.status, 503);
    assert.equal(problem.code, 'SERVICIO_NO_DISPONIBLE');
    assert.equal(
      received.length,
      count,
      'failed grant must not issue an anonymous upstream call',
    );
    assert.equal(
      JSON.stringify(problem).includes('synthetic-wiring-secret'),
      false,
    );
    assert.deepEqual((await snapshot()).rows, before.rows);
    return [
      'authenticated native Nest HTTP/PG wiring: real token/JWKS/identity/commercial factories, scope-specific G7 contract fixture tokens used by real HTTP upstreams, cache reused, incoming bearer never forwarded',
      'native module rejects invalid inbound JWT and denied outbound grant without anonymous upstream calls or coupon/Inbox/Outbox writes',
    ];
  } finally {
    await app?.close();
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
