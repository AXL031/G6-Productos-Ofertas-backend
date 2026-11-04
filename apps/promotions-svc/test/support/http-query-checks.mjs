// Runs inside the disposable PostgreSQL suite. JWT signatures and DB queries are real.
// Commercial facts below are explicit test fixtures; production keeps its blocked provider.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PromotionsSvcModule } from '../../../../dist/apps/promotions-svc/promotions-svc.module.js';
import { PromotionsConfigService } from '../../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import { PromotionsPersistence } from '../../../../dist/apps/promotions-svc/infrastructure/persistence/promotions-persistence.js';
import { COUPON_RESOURCES } from '../../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import { PROMOTIONS_JWKS } from '../../../../dist/apps/promotions-svc/http/promotions-identity.js';
import { COMMERCIAL_CONTEXT } from '../../../../dist/apps/promotions-svc/domain/commercial-context.js';
import { httpContracts } from '../../../../dist/apps/promotions-svc/http/http-contract.generated.js';
import { valid } from '../../../../dist/apps/promotions-svc/http/http-validation.js';
import { PROMOTIONS_CLOCK } from '../../../../dist/apps/promotions-svc/domain/clock.js';
import {
  PROMOTIONS_OPERATION_LOGGER,
  PromotionsOperationLogger,
} from '../../../../dist/apps/promotions-svc/infrastructure/logging/operation-logger.js';
import {
  assertPromotion,
  assertCoupon,
} from '../../../../dist/apps/promotions-svc/domain/promotion-rules.js';

export async function verifyHttpReadQueries(resources, baseConfig) {
  const checks = [];
  const policy = {
    pricingOffer: false,
    automaticPromotion: false,
    coupon: false,
  };
  const persistence = new PromotionsPersistence(resources.pool);
  const campaign = {
    name: 'ISOLATED-HTTP',
    discountType: 'PORCENTAJE',
    discountValue: '10',
    modality: 'CUPON',
    state: 'ACTIVO',
    validFrom: '2026-10-01T00:00:00Z',
    validUntil: '2026-12-01T00:00:00Z',
    priority: 1,
    enabledChannels: ['MARKETPLACE'],
  };
  const seeded = await persistence.transaction(async (r) => {
    assertPromotion(campaign, [{ sku: 'HTTP-SKU' }], policy);
    const p = await r.promotions.create(
      campaign,
      [{ sku: 'HTTP-SKU' }],
      policy,
    );
    const c = {
      promotionId: p.id,
      code: 'HTTP_ONLY',
      state: 'ACTIVO',
      maxGlobalUses: 2,
      cancellationPolicy: 'RESTAURAR_EN_CANCELACION',
    };
    assertCoupon(c);
    const coupon = await r.coupons.create(c);
    const draft = await r.promotions.create(
      { ...campaign, name: 'NEVER-ACTIVATED', state: 'INACTIVO' },
      [{ productId: 'HTTP-PRODUCT' }],
      policy,
    );
    const rule = await r.recommendations.create(
      {
        name: 'HTTP-CROSS',
        recommendationType: 'CROSS_SELL',
        originType: 'PRODUCTO',
        originId: 'HTTP-ORIGIN',
        priority: 1,
        state: 'ACTIVO',
        validFrom: campaign.validFrom,
        validUntil: campaign.validUntil,
      },
      [
        { productId: 'HTTP-A', itemOrder: 1 },
        { productId: 'HTTP-OUT', itemOrder: 2 },
      ],
    );
    await r.recommendations.create(
      {
        name: 'HTTP-CROSS-SECOND',
        recommendationType: 'CROSS_SELL',
        originType: 'CATEGORIA',
        originId: 'HTTP-CATEGORY',
        priority: 2,
        state: 'ACTIVO',
        validFrom: campaign.validFrom,
        validUntil: campaign.validUntil,
      },
      [
        { productId: 'HTTP-A', itemOrder: 1 },
        { productId: 'HTTP-B', itemOrder: 2 },
      ],
    );
    return { p, coupon, draft, rule };
  });
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'isolated-http-key',
    alg: 'RS256',
    use: 'sig',
  };
  const config = new PromotionsConfigService({
    ...baseConfig.settings,
    auth: {
      issuer: 'https://isolated.test/auth',
      jwksUrl: 'https://isolated.test/jwks',
    },
  });
  function token(claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid: key.kid, typ: 'JWT' },
      {
        iss: config.settings.auth.issuer,
        sub: randomUUID(),
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...claims,
      },
    ].map((x) => Buffer.from(JSON.stringify(x)).toString('base64url'));
    return (
      parts.join('.') +
      '.' +
      sign(
        'RSA-SHA256',
        Buffer.from(parts.join('.')),
        pair.privateKey,
      ).toString('base64url')
    );
  }
  const user = token();
  const service = (scope) =>
    token({
      sub: 'modulo-marketplace',
      tipo: 'servicio',
      aud: ['api-productos'],
      scope,
      roles: undefined,
    });
  const before = await resources.pool.query(
    'SELECT (SELECT count(*)::int FROM promotions.coupon_uses) AS uses, (SELECT count(*)::int FROM promotions.coupon_command_receipts) AS receipts, (SELECT count(*)::int FROM promotions.inbox) AS inbox, (SELECT count(*)::int FROM promotions.outbox) AS outbox',
  );
  let app;
  async function start(facts) {
    const observations = [];
    const builder = Test.createTestingModule({ imports: [PromotionsSvcModule] })
      .overrideProvider(PromotionsConfigService)
      .useValue(config)
      .overrideProvider(PROMOTIONS_CLOCK)
      .useValue({ now: () => new Date('2026-10-22T12:00:00Z') })
      .overrideProvider(COUPON_RESOURCES)
      .useValue({ ...resources, onApplicationShutdown: async () => undefined })
      .overrideProvider(PROMOTIONS_JWKS)
      .useValue(async () => [key])
      .overrideProvider(PROMOTIONS_OPERATION_LOGGER)
      .useValue(
        new PromotionsOperationLogger((line) =>
          observations.push(JSON.parse(line)),
        ),
      );
    if (facts) builder.overrideProvider(COMMERCIAL_CONTEXT).useValue(facts);
    const module = await builder.compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    return async (id, path, bearer, body, expected = 200) => {
      const trace = randomUUID();
      const headers = {
        'X-Correlation-Id': trace,
        ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      };
      const response = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers,
        ...(body
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(7000),
      });
      const data = await response.json();
      assert.equal(response.status, expected, `${id}: ${JSON.stringify(data)}`);
      assert.equal(response.headers.get('x-correlation-id'), trace);
      const matching = observations.filter(
        (entry) => entry.correlation_id === trace,
      );
      assert.equal(
        matching.length,
        1,
        'exactly one operation observation per request',
      );
      assert.equal(
        matching[0].operation,
        id,
        'static routes must not be attributed to parameterized routes',
      );
      assert.equal(matching[0].status, expected);
      assert.ok(Number.isFinite(matching[0].duration_ms));
      const serialized = JSON.stringify(matching);
      for (const secret of [
        bearer,
        baseConfig.settings.database.password,
        body?.customer_ref,
        body?.coupon_code,
      ].filter(Boolean))
        assert.equal(
          serialized.includes(secret),
          false,
          'no credentials or business identifiers in telemetry',
        );
      if (expected === 200) {
        assert.equal(
          valid(data, httpContracts[id].response),
          true,
          id + ' official response schema',
        );
      } else {
        assert.match(
          response.headers.get('content-type'),
          /^application\/problem\+json/,
        );
        assert.equal(data.correlationId, trace);
        assert.equal(data.status, expected);
        assert.ok(
          httpContracts[id].errors[String(expected)].includes(data.code),
        );
        assert.equal(
          JSON.stringify(data).includes(baseConfig.settings.database.password),
          false,
        );
      }
      return data;
    };
  }
  try {
    let call = await start();
    for (const [id, path] of [
      ['listarPromociones', '/api/v1/promociones?canal=MARKETPLACE'],
      ['listarPromocionesAdmin', '/api/v1/promociones/administracion'],
      ['listarCupones', '/api/v1/cupones'],
      ['listarReglasRecomendacion', '/api/v1/recomendaciones/reglas'],
    ])
      await call(id, path, undefined, undefined, 401);
    await call(
      'listarCupones',
      '/api/v1/cupones',
      service('promociones:leer'),
      undefined,
      403,
    );
    await call(
      'listarPromociones',
      '/api/v1/promociones?canal=MARKETPLACE',
      token({
        sub: 'modulo-ventas',
        tipo: 'servicio',
        aud: ['api-productos'],
        scope: 'promociones:leer',
      }),
      undefined,
      403,
    );
    await call(
      'listarPromociones',
      '/api/v1/promociones?canal=MARKETPLACE',
      service('cupones:validar'),
      undefined,
      403,
    );
    const active = await call(
      'listarPromociones',
      '/api/v1/promociones?canal=MARKETPLACE',
      service('promociones:leer'),
    );
    assert.ok(active.items.some((p) => p.promotion_id === seeded.p.id));
    assert.ok(active.items.every((p) => p.status === 'ACTIVA'));
    await call(
      'listarPromociones',
      '/api/v1/promociones?canal=BAD',
      user,
      undefined,
      400,
    );
    await call(
      'listarPromociones',
      '/api/v1/promociones?canal=MARKETPLACE&vigentes=1',
      user,
      undefined,
      400,
    );
    await call(
      'listarCupones',
      '/api/v1/cupones?pagina=0',
      user,
      undefined,
      400,
    );
    await call(
      'listarCupones',
      '/api/v1/cupones?tamanio=201',
      user,
      undefined,
      400,
    );
    await call(
      'listarCupones',
      '/api/v1/cupones?estado=ACTIVA',
      user,
      undefined,
      400,
    );
    const empty = await call(
      'listarCupones',
      '/api/v1/cupones?estado=INACTIVO',
      user,
    );
    assert.deepEqual(empty.items, []);
    assert.equal(empty.meta.totalPaginas, 0);
    const first = await call(
      'listarCupones',
      '/api/v1/cupones?pagina=1&tamanio=1',
      user,
    );
    const second = await call(
      'listarCupones',
      '/api/v1/cupones?pagina=2&tamanio=1',
      user,
    );
    assert.equal(first.meta.tamanio, 1);
    assert.equal(first.meta.total, second.meta.total);
    assert.notEqual(first.items[0].cuponId, second.items[0].cuponId);
    await call(
      'listarPromocionesAdmin',
      '/api/v1/promociones/administracion?modalidad=CUPON&estado=INACTIVO',
      user,
    );
    await call(
      'listarReglasRecomendacion',
      '/api/v1/recomendaciones/reglas?tipo=CROSS_SELL&tamanio=1',
      user,
    );
    await call(
      'obtenerCuponAdmin',
      '/api/v1/cupones/' + seeded.coupon.id,
      user,
    );
    const draft = await call(
      'obtenerPromocionAdmin',
      '/api/v1/promociones/' + seeded.draft.id,
      user,
    );
    assert.equal(draft.puedeCambiarModalidad, true);
    assert.equal(
      (
        await call(
          'obtenerPromocionAdmin',
          '/api/v1/promociones/' + seeded.p.id,
          user,
        )
      ).puedeCambiarModalidad,
      false,
    );
    await call(
      'obtenerReglaRecomendacion',
      '/api/v1/recomendaciones/reglas/' + seeded.rule.id,
      user,
    );
    for (const [id, path] of [
      ['obtenerCuponAdmin', '/api/v1/cupones/'],
      ['obtenerPromocionAdmin', '/api/v1/promociones/'],
      ['obtenerReglaRecomendacion', '/api/v1/recomendaciones/reglas/'],
    ]) {
      await call(id, path + randomUUID(), user, undefined, 404);
      await call(id, path + 'opaque-invalid-id', user, undefined, 404);
    }
    const basket = {
      channel_id: 'MARKETPLACE',
      lines: [{ sku: 'HTTP-SKU', quantity: 1 }],
    };
    await call(
      'evaluarPromociones',
      '/api/v1/promociones/evaluar',
      service('promociones:evaluar'),
      '{broken',
      400,
    );
    await call(
      'evaluarPromociones',
      '/api/v1/promociones/evaluar',
      service('promociones:evaluar'),
      { ...basket, lines: [] },
      400,
    );
    await call(
      'evaluarPromociones',
      '/api/v1/promociones/evaluar',
      service('promociones:evaluar'),
      basket,
      503,
    );
    await call(
      'validarCupon',
      '/api/v1/cupones/validar',
      service('cupones:validar'),
      { ...basket, coupon_code: 'HTTP_ONLY' },
      503,
    );
    await call(
      'obtenerRecomendaciones',
      '/api/v1/recomendaciones?productoId=HTTP-ORIGIN&canal=MARKETPLACE',
      service('recomendaciones:leer'),
      undefined,
      503,
    );
    checks.push(
      'real HTTP/PG: seven master/list/detail routes, official DTOs, filters/pagination, 400/401/403/404 and explicit production commercial-source gates',
    );
    await app.close();
    app = undefined;
    const fixtureFacts = {
      basket: async (body) => ({
        lines: body.lines.map((l) => ({
          sku: l.sku,
          productId: 'HTTP-PRODUCT',
          quantity: l.quantity,
          regular: '100',
          offer: null,
          currency: 'PEN',
          active: true,
          channelEligible: true,
        })),
      }),
      recommendationOrigin: async (id) => ({
        active: id !== 'HTTP-NONE',
        channelEligible: true,
        categoryId: 'HTTP-CATEGORY',
      }),
      recommendationProducts: async (ids) =>
        new Map(
          ids.map((id) => [
            id,
            {
              active: true,
              channelEligible: true,
              availability: id === 'HTTP-OUT' ? 'AGOTADO' : 'DISPONIBLE',
              currentPrice: null,
            },
          ]),
        ),
    };
    call = await start(fixtureFacts);
    const evaluated = await call(
      'evaluarPromociones',
      '/api/v1/promociones/evaluar',
      service('promociones:evaluar'),
      { ...basket, coupon_code: 'HTTP_ONLY' },
    );
    assert.equal(evaluated.promotion_id, seeded.p.id);
    assert.equal(evaluated.original_amount, 100);
    assert.equal(evaluated.discount_amount, 10);
    assert.equal(evaluated.result_amount, 90);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await call(
            'validarCupon',
            '/api/v1/cupones/validar',
            service('cupones:validar'),
            { ...basket, coupon_code: ' http_only ' },
          )
        ).valid,
        true,
      );
    const missing = await call(
      'validarCupon',
      '/api/v1/cupones/validar',
      service('cupones:validar'),
      { ...basket, coupon_code: 'MISSING' },
    );
    assert.equal(missing.valid, false);
    assert.equal(missing.code, 'CUPON_NO_ENCONTRADO');
    const recs = await call(
      'obtenerRecomendaciones',
      '/api/v1/recomendaciones?productoId=HTTP-ORIGIN&canal=MARKETPLACE',
      service('recomendaciones:leer'),
    );
    assert.deepEqual(
      recs.recommendations.map((r) => r.product_id),
      ['HTTP-A', 'HTTP-B'],
    );
    const noRecs = await call(
      'obtenerRecomendaciones',
      '/api/v1/recomendaciones?productoId=HTTP-NONE&canal=MARKETPLACE',
      service('recomendaciones:leer'),
    );
    assert.deepEqual(noRecs.recommendations, []);
    await app.close();
    app = undefined;
    let timeoutCalls = 0;
    let timeoutSignal;
    call = await start({
      ...fixtureFacts,
      basket: async (_body, _at, signal) => {
        timeoutCalls++;
        timeoutSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(
                new Error('fixture transport aborted; secret diagnostics'),
              ),
            { once: true },
          );
        });
      },
      recommendationProducts: async () => {
        throw new Error('fixture upstream failure with private customer data');
      },
    });
    await call(
      'evaluarPromociones',
      '/api/v1/promociones/evaluar',
      service('promociones:evaluar'),
      basket,
      503,
    );
    assert.equal(timeoutCalls, 1, 'no implicit commercial retry');
    assert.equal(timeoutSignal.aborted, true, 'deadline reaches the transport');
    await call(
      'obtenerRecomendaciones',
      '/api/v1/recomendaciones?productoId=HTTP-ORIGIN&canal=MARKETPLACE',
      service('recomendaciones:leer'),
      undefined,
      503,
    );
    checks.push(
      'commercial timeout aborts its explicit fixture transport once; upstream errors become sanitized contractual 503, never empty recommendations',
    );
    const after = await resources.pool.query(
      'SELECT (SELECT count(*)::int FROM promotions.coupon_uses) AS uses, (SELECT count(*)::int FROM promotions.coupon_command_receipts) AS receipts, (SELECT count(*)::int FROM promotions.inbox) AS inbox, (SELECT count(*)::int FROM promotions.outbox) AS outbox',
    );
    assert.deepEqual(after.rows, before.rows);
    checks.push(
      'real HTTP/PG with explicit isolated facts: evaluate/validate success and coupon rejection, recommendation ordering/filter/dedupe, zero new uses/receipts/Inbox/Outbox after retries',
    );
    await resources.pool.end();
    await call('listarCupones', '/api/v1/cupones', user, undefined, 503);
    checks.push(
      'closed real PG pool produces sanitized contractual 503 without leaking driver/configuration values',
    );
    return checks;
  } finally {
    await app?.close();
  }
}
