// Real Nest factories, HTTP and disposable PostgreSQL. Only G7 and upstream
// business facts are explicit fixtures; token/identity/commercial providers stay real.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import { PromotionsSvcModule } from '../../../../dist/apps/promotions-svc/promotions-svc.module.js';
import { PromotionsConfigService } from '../../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import { COUPON_RESOURCES } from '../../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import { PromotionsPersistence } from '../../../../dist/apps/promotions-svc/infrastructure/persistence/promotions-persistence.js';
import { PROMOTIONS_CLOCK } from '../../../../dist/apps/promotions-svc/domain/clock.js';
import { httpContracts } from '../../../../dist/apps/promotions-svc/http/http-contract.generated.js';
import { valid } from '../../../../dist/apps/promotions-svc/http/http-validation.js';

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
  let fault = '';
  const nativeFetch = globalThis.fetch;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const scope = req.url.startsWith('/api/v1/precios/')
      ? 'precios:leer'
      : req.url.includes('/inventario/')
        ? 'inventario:disponibilidad:leer'
        : 'catalogo:leer';
    received.push({
      path: req.url,
      authorization: req.headers.authorization,
      scope,
      method: req.method,
      correlationId: req.headers['x-correlation-id'],
    });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ' + issued.get(scope)) {
      res.statusCode = 403;
      res.end('{}');
      return;
    }
    if (fault === 'denied' && scope === 'inventario:disponibilidad:leer') {
      res.statusCode = 403;
      res.end(JSON.stringify({ privateDiagnostic: 'fixture-private' }));
      return;
    }
    const productId = url.pathname.split('/').at(-1);
    const sku = url.pathname.split('/').at(-1);
    const recommended = productId !== 'WIRING-P';
    if (fault === 'missing-price' && scope === 'precios:leer') {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 404, code: 'PRECIO_NO_ENCONTRADO' }));
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
      : req.url.includes('/inventario/')
        ? {
            items: url.searchParams
              .get('skus')
              .split(',')
              .map((sku) => ({
                sku,
                status:
                  fault === 'unknown-stock'
                    ? 'INDETERMINADO'
                    : sku.endsWith('-2')
                      ? 'STOCK_BAJO'
                      : 'DISPONIBLE',
              })),
          }
        : req.url.includes('/precios/')
          ? {
              sku,
              precio_regular:
                sku === 'WIRING-SKU' ? 100 : sku.endsWith('-2') ? 20 : 30,
              precio_oferta:
                sku === 'WIRING-SKU' ? 80 : sku.endsWith('-2') ? null : 24,
              currency: 'PEN',
              channel_id: null,
              valid_from: '2026-01-01T00:00:00Z',
              valid_until:
                fault === 'expired-price' ? '2026-10-22T12:00:00Z' : null,
              price_version: 1,
              vigencia_id: 'WIRING-V',
              origen: 'PRODUCTO',
            }
          : {
              product_id: productId,
              name: 'Fixture',
              slug: 'fixture',
              categoria_id: 'WIRING-C',
              marca_id: 'M',
              tipo_producto_id: 'T',
              tiene_variantes: recommended,
              sku_base: recommended ? null : 'WIRING-SKU',
              marca: { marca_id: 'M', name: 'M' },
              variants: recommended
                ? [
                    { variant_id: 'WIRING-V1', sku: 'WIRING-Q-1' },
                    { variant_id: 'WIRING-V2', sku: 'WIRING-Q-2' },
                  ]
                : [],
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
        assert.ok(
          [
            'catalogo:leer',
            'precios:leer',
            'inventario:disponibilidad:leer',
          ].includes(scope),
        );
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
        .overrideProvider(PROMOTIONS_CLOCK)
        .useValue({ now: () => new Date('2026-10-22T12:00:00Z') })
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

    // Explicit commercial fixtures exercise the native adapters and business
    // engine together. They do not establish provider authorization or grants.
    const persistence = new PromotionsPersistence(resources.pool);
    const seeded = await persistence.transaction(async (r) => {
      const campaign = {
        name: 'MARKETPLACE-NATIVE-FIXTURE',
        discountType: 'PORCENTAJE',
        discountValue: '10',
        modality: 'AUTOMATICA',
        state: 'ACTIVO',
        validFrom: '2026-10-01T00:00:00Z',
        validUntil: '2026-12-01T00:00:00Z',
        priority: 1,
        enabledChannels: ['MARKETPLACE'],
      };
      const policy = {
        pricingOffer: true,
        automaticPromotion: true,
        coupon: true,
      };
      const automatic = await r.promotions.create(
        campaign,
        [{ productId: 'WIRING-P' }],
        policy,
      );
      const promotion = await r.promotions.create(
        { ...campaign, modality: 'CUPON', priority: 2 },
        [{ sku: 'WIRING-SKU' }],
        policy,
      );
      const code = 'NATIVE_' + randomUUID().replaceAll('-', '').toUpperCase();
      await r.coupons.create({
        promotionId: promotion.id,
        code,
        state: 'ACTIVO',
        maxGlobalUses: 1,
        maxCustomerUses: 1,
        cancellationPolicy: 'RESTAURAR_EN_CANCELACION',
      });
      await r.recommendations.create(
        {
          name: 'NATIVE-CROSS',
          recommendationType: 'CROSS_SELL',
          originType: 'PRODUCTO',
          originId: 'WIRING-P',
          priority: 1,
          state: 'ACTIVO',
          validFrom: campaign.validFrom,
          validUntil: campaign.validUntil,
        },
        [{ productId: 'WIRING-Q', itemOrder: 1 }],
      );
      return { automatic, promotion, code };
    });
    const allRows = async () => {
      const names = (
        await resources.pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='promotions' ORDER BY tablename",
        )
      ).rows;
      const rows = {};
      for (const { tablename } of names) {
        assert.match(tablename, /^[a-z_]+$/);
        rows[tablename] = (
          await resources.pool.query(
            `SELECT to_jsonb(t) AS row FROM promotions."${tablename}" t ORDER BY to_jsonb(t)::text`,
          )
        ).rows;
      }
      return rows;
    };
    const savedRows = await allRows();
    const scenarioEvidence = [];
    const basket = {
      channel_id: 'MARKETPLACE',
      lines: [{ sku: 'WIRING-SKU', quantity: 1 }],
      coupon_code: seeded.code,
      customer_ref: randomUUID(),
    };
    const http = async (operation, path, scope, data, expected = 200) => {
      const trace = randomUUID();
      const start = received.length;
      const response = await nativeFetch(base + path, {
        method: data ? 'POST' : 'GET',
        headers: {
          authorization:
            'Bearer ' +
            jwt({
              sub: 'modulo-marketplace',
              tipo: 'servicio',
              aud: ['api-productos'],
              scope,
            }),
          'content-type': 'application/json',
          'x-correlation-id': trace,
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
        signal: AbortSignal.timeout(9000),
      });
      const body = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      assert.equal(response.headers.get('x-correlation-id'), trace);
      if (expected === 200)
        assert.equal(
          valid(body, httpContracts[operation].response),
          true,
          JSON.stringify(body),
        );
      else {
        assert.equal(body.correlationId, trace);
        assert.equal(
          body.code,
          expected === 503 ? 'SERVICIO_NO_DISPONIBLE' : 'VALIDACION',
        );
        assert.equal(JSON.stringify(body).includes('fixture-private'), false);
      }
      const outbound = received.slice(start);
      assert.ok(
        outbound.every((r) => r.correlationId === trace && r.method === 'GET'),
      );
      assert.ok(
        outbound.every(
          (r) => r.authorization === 'Bearer ' + issued.get(r.scope),
        ),
      );
      const dates = outbound
        .filter((r) => r.scope === 'precios:leer')
        .map((r) => new URL(r.path, upstream).searchParams.get('at'));
      assert.ok(
        dates.every((at) => at === (data?.at ?? '2026-10-22T12:00:00.000Z')),
      );
      scenarioEvidence.push({
        operation,
        path,
        fixtureMode: fault || 'positive',
        status: response.status,
        correlationId: trace,
        body,
        upstream: outbound.map(({ path, method, scope, correlationId }) => ({
          path,
          method,
          scope,
          correlationId,
        })),
      });
      return body;
    };
    const evaluate = (data = basket, status = 200) =>
      http(
        'evaluarPromociones',
        '/api/v1/promociones/evaluar',
        'promociones:evaluar',
        data,
        status,
      );
    const validate = (data = basket, status = 200) =>
      http(
        'validarCupon',
        '/api/v1/cupones/validar',
        'cupones:validar',
        data,
        status,
      );
    const recommend = (status = 200) =>
      http(
        'obtenerRecomendaciones',
        '/api/v1/recomendaciones?productoId=WIRING-P&canal=MARKETPLACE',
        'recomendaciones:leer',
        undefined,
        status,
      );
    const listed = await http(
      'listarPromociones',
      '/api/v1/promociones?canal=MARKETPLACE',
      'promociones:leer',
    );
    assert.ok(listed.items.some((p) => p.promotion_id === seeded.automatic.id));
    for (let attempt = 0; attempt < 3; attempt++) {
      const evaluated = await evaluate();
      assert.equal(evaluated.result_amount, 64.8);
      assert.equal(evaluated.discount_amount, 35.2);
      assert.equal(evaluated.promotion_id, seeded.automatic.id);
      const validated = await validate();
      assert.equal(validated.valid, true);
      assert.equal(validated.result_amount, 72);
      assert.equal(validated.benefit.promotion_id, seeded.promotion.id);
    }
    const unknown = await validate({
      ...basket,
      coupon_code: 'UNKNOWN_FIXTURE',
    });
    assert.equal(unknown.valid, false);
    assert.equal(unknown.code, 'CUPON_NO_ENCONTRADO');
    const recommendations = await recommend();
    assert.deepEqual(recommendations.recommendations, [
      {
        product_id: 'WIRING-Q',
        type: 'CROSS_SELL',
        rule_priority: 1,
        presentation_order: 1,
        current_price: 20,
        availability: 'DISPONIBLE',
      },
    ]);
    fault = 'unknown-stock';
    assert.deepEqual((await recommend()).recommendations, []);
    fault = 'missing-price';
    assert.deepEqual((await recommend()).recommendations, []);
    await evaluate(basket, 503);
    fault = 'expired-price';
    await evaluate(basket, 503);
    await validate(basket, 503);
    await recommend(503);
    fault = 'denied';
    await recommend(503);
    fault = '';
    await evaluate(
      {
        ...basket,
        lines: [{ sku: 'OTHER-SKU', product_id: 'WIRING-P', quantity: 1 }],
      },
      400,
    );
    await evaluate(
      { ...basket, lines: [{ sku: 'WIRING-SKU', quantity: 0 }] },
      400,
    );
    assert.equal((await evaluate()).result_amount, 64.8);
    assert.deepEqual(
      await allRows(),
      savedRows,
      'all persisted Promotions rows must be unchanged, including coupon quotas, uses, receipts, Inbox and Outbox',
    );
    mkdirSync(resolve('apps/promotions-svc/test/evidence'), {
      recursive: true,
    });
    writeFileSync(
      resolve(
        'apps/promotions-svc/test/evidence/marketplace-native-2026-11-04.json',
      ),
      JSON.stringify(
        {
          status: 'PASS',
          scope:
            'native Promotions module + disposable PostgreSQL/TLS; commercial and G7 facts are EXPLICIT FIXTURES, not real provider or G7 integration',
          harnessSha256: createHash('sha256')
            .update(readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          authenticatedInbound:
            'local signed RS256 JWT with native JWKS/identity provider',
          nativeProviders: [
            'PromotionsPersistence',
            'COMMERCIAL_CONTEXT',
            'service tokens',
            'JWT/JWKS verifier',
          ],
          overrides: [
            'test configuration',
            'isolated PostgreSQL resources',
            'fixed business clock',
          ],
          fixtures: [
            'G7 token/JWKS HTTP responses via explicit fetch interception',
            'commercial upstream HTTP server with synthetic prices, stock and product data',
          ],
          readOnly: {
            allPromotionsTablesEqual: true,
            beforeRowsSha256: createHash('sha256')
              .update(JSON.stringify(savedRows))
              .digest('hex'),
            commercialRequestsGetOnly: true,
            reservationCommandsSent: 0,
          },
          scenarios: scenarioEvidence,
        },
        null,
        2,
      ) + '\n',
    );
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
      'Marketplace native Nest HTTP/adapters/PG with explicit G7 and commercial fixtures: list, Pricing+automatic+coupon 64.80, standalone coupon 72.00, repeat without consuming one-use quota, unknown coupon and invalid input',
      'native recommendations fixture: Catalog variants + Inventory positive SKUs + current Pricing minimum 20.00; unknown stock and absent prices exclude; expired prices/403 fail closed; request correlation, common instant and scope-specific tokens verified for every outgoing read',
      'complete before/after row equality across every Promotions table; all commercial upstream calls GET only; no reservation command or write request',
    ];
  } finally {
    await app?.close();
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
