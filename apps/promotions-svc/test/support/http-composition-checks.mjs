// Approved v1 composition through real HTTP, JWT guards and PostgreSQL/TLS.
// Commercial facts/JWKS are isolated fixtures, never shared provider evidence.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PromotionsSvcModule } from '../../../../dist/apps/promotions-svc/promotions-svc.module.js';
import { PromotionsConfigService } from '../../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import { PromotionsPersistence } from '../../../../dist/apps/promotions-svc/infrastructure/persistence/promotions-persistence.js';
import { COUPON_RESOURCES } from '../../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import { PROMOTIONS_JWKS } from '../../../../dist/apps/promotions-svc/http/promotions-identity.js';
import { COMMERCIAL_CONTEXT } from '../../../../dist/apps/promotions-svc/domain/commercial-context.js';
import { PROMOTIONS_CLOCK } from '../../../../dist/apps/promotions-svc/domain/clock.js';
import { httpContracts } from '../../../../dist/apps/promotions-svc/http/http-contract.generated.js';
import { valid } from '../../../../dist/apps/promotions-svc/http/http-validation.js';

export async function verifyHttpComposition(resources, baseConfig) {
  const persistence = new PromotionsPersistence(resources.pool);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'composition-fixture',
    alg: 'RS256',
    use: 'sig',
  };
  const issuer = 'https://composition.fixture/api/v1/auth';
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    { alg: 'RS256', kid: key.kid },
    {
      iss: issuer,
      sub: 'modulo-marketplace',
      tipo: 'servicio',
      aud: ['api-productos'],
      scope: 'promociones:evaluar cupones:validar',
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
    },
  ].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'));
  const bearer =
    parts.join('.') +
    '.' +
    sign('RSA-SHA256', Buffer.from(parts.join('.')), pair.privateKey).toString(
      'base64url',
    );
  let prices = { 'C72-A': { regular: '100', offer: null } };
  let currency = 'PEN';
  const ids = [];
  const policy = {
    pricingOffer: false,
    automaticPromotion: true,
    coupon: true,
  };
  const campaign = (
    discountValue,
    scopes = [{ productId: 'C72-P' }],
    changes = {},
    combination = policy,
  ) =>
    persistence.transaction(async (r) => {
      const saved = await r.promotions.create(
        {
          name: 'HTTP-COMPOSITION-FIXTURE',
          discountType: 'PORCENTAJE',
          discountValue,
          modality: 'AUTOMATICA',
          state: 'ACTIVO',
          validFrom: '2026-10-01T00:00:00Z',
          validUntil: '2026-12-01T00:00:00Z',
          priority: ids.length + 1,
          enabledChannels: ['MARKETPLACE'],
          ...changes,
        },
        scopes,
        combination,
      );
      ids.push(saved.id);
      return saved;
    });
  const deactivate = () =>
    persistence.transaction(async (r) => {
      for (const id of ids)
        await r.promotions.update(id, { state: 'INACTIVO' });
      ids.length = 0;
    });
  const counters = () =>
    resources.pool.query(
      'SELECT (SELECT count(*)::int FROM promotions.coupon_uses) AS uses, (SELECT count(*)::int FROM promotions.coupon_command_receipts) AS receipts, (SELECT count(*)::int FROM promotions.inbox) AS inbox, (SELECT count(*)::int FROM promotions.outbox) AS outbox',
    );
  const before = await counters();
  let app;
  try {
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useValue(
        new PromotionsConfigService({
          ...baseConfig.settings,
          localDemoEnabled: false,
          auth: { issuer, jwksUrl: issuer + '/jwks' },
        }),
      )
      .overrideProvider(PROMOTIONS_JWKS)
      .useValue(async () => [key])
      .overrideProvider(PROMOTIONS_CLOCK)
      .useValue({ now: () => new Date('2026-10-22T12:00:00Z') })
      .overrideProvider(COUPON_RESOURCES)
      .useValue({ ...resources, onApplicationShutdown: async () => undefined })
      .overrideProvider(COMMERCIAL_CONTEXT)
      .useValue({
        basket: async (body) => ({
          lines: body.lines.map((l) => ({
            sku: l.sku,
            productId: 'C72-P',
            quantity: l.quantity,
            ...(prices[l.sku] ?? prices['C72-A']),
            currency,
            active: true,
            channelEligible: true,
          })),
        }),
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const body = {
      channel_id: 'MARKETPLACE',
      lines: [{ sku: 'C72-A', quantity: 1 }],
    };
    const call = async (
      data = body,
      id = 'evaluarPromociones',
      expected = 200,
    ) => {
      const path =
        id === 'evaluarPromociones'
          ? '/api/v1/promociones/evaluar'
          : '/api/v1/cupones/validar';
      const trace = randomUUID();
      const response = await fetch(base + path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + bearer,
          'content-type': 'application/json',
          'x-correlation-id': trace,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(9000),
      });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      assert.equal(response.headers.get('x-correlation-id'), trace);
      if (expected === 200)
        assert.equal(valid(result, httpContracts[id].response), true);
      else {
        assert.equal(result.code, 'SERVICIO_NO_DISPONIBLE');
        assert.equal(result.correlationId, trace);
        assert.ok(
          httpContracts[id].errors[String(expected)].includes(result.code),
        );
      }
      return result;
    };
    const first = await campaign('10');
    await campaign('20');
    const result = await call();
    assert.equal(result.result_amount, 72);
    assert.equal(result.discount_amount, 28);
    assert.equal(result.promotion_id, first.id);
    assert.deepEqual(await call(), result);
    assert.equal(
      (await call({ ...body, lines: [body.lines[0], body.lines[0]] }))
        .result_amount,
      144,
    );
    await deactivate();

    prices = {
      'C72-A': { regular: '1', offer: null },
      'C72-B': { regular: '2', offer: null },
    };
    const fixed = await campaign(
      '1',
      [{ productId: 'C72-P' }, { sku: 'C72-A' }],
      { discountType: 'MONTO_FIJO' },
    );
    await campaign('50', [{ sku: 'C72-A' }]);
    const basket = {
      ...body,
      lines: [
        { sku: 'C72-A', quantity: 1 },
        { sku: 'C72-B', quantity: 1 },
      ],
    };
    const rounded = await call(basket);
    assert.deepEqual(rounded, {
      promotion_id: fixed.id,
      original_amount: 3,
      discount_amount: 1.33,
      result_amount: 1.67,
      currency: 'PEN',
      reason: null,
    });
    assert.deepEqual(
      await call({ ...basket, lines: [...basket.lines].reverse() }),
      rounded,
    );
    await deactivate();

    prices = { 'C72-A': { regular: '100', offer: null } };
    await campaign(
      '50',
      undefined,
      {},
      { pricingOffer: false, automaticPromotion: false, coupon: false },
    );
    const subset = await campaign('30');
    await campaign('40');
    assert.equal((await call()).result_amount, 42);
    assert.equal((await call()).promotion_id, subset.id);
    await deactivate();

    const automatic = await campaign('10');
    const couponCampaign = await campaign('10', undefined, {
      modality: 'CUPON',
    });
    const code = 'HTTP_C72_' + randomUUID().replaceAll('-', '').toUpperCase();
    await persistence.transaction((r) =>
      r.coupons.create({
        promotionId: couponCampaign.id,
        code,
        state: 'ACTIVO',
        maxGlobalUses: 2,
        cancellationPolicy: 'RESTAURAR_EN_CANCELACION',
      }),
    );
    const withCoupon = { ...body, coupon_code: code };
    const combined = await call(withCoupon);
    assert.equal(combined.result_amount, 81);
    assert.equal(combined.promotion_id, automatic.id);
    for (let i = 0; i < 2; i++) {
      const validated = await call(withCoupon, 'validarCupon');
      assert.equal(validated.valid, true);
      assert.equal(validated.benefit.promotion_id, couponCampaign.id);
      assert.equal(validated.result_amount, 90);
    }
    prices['C72-A'].offer = '80';
    assert.equal((await call(withCoupon)).promotion_id, null);
    assert.equal((await call(withCoupon)).result_amount, 80);
    assert.equal((await call(withCoupon, 'validarCupon')).result_amount, 90);
    await deactivate();

    const pricingPolicy = { ...policy, pricingOffer: true };
    await campaign('10', undefined, {}, pricingPolicy);
    await campaign('20', undefined, {}, pricingPolicy);
    assert.equal((await call()).result_amount, 57.6);
    await deactivate();

    for (const value of [
      { regular: '0.001', offer: null },
      { regular: '100000000000000.01', offer: null },
    ]) {
      prices = { 'C72-A': value };
      await call(body, 'evaluarPromociones', 503);
    }
    prices = { 'C72-A': { regular: '100', offer: null } };
    currency = 'USD';
    await call(body, 'evaluarPromociones', 503);
    currency = 'PEN';
    for (let i = 0; i < 13; i++) await campaign('1');
    await call(body, 'evaluarPromociones', 503);
    await deactivate();
    await call(
      { ...body, lines: Array.from({ length: 101 }, () => body.lines[0]) },
      'evaluarPromociones',
      503,
    );
    assert.deepEqual((await counters()).rows, before.rows);
    return [
      'HTTP/PG composition v1: successive automatic benefits, best compatible subset, canonical duplicate SKU, scope dedupe, fixed-once proportional allocation, half-up total and input-order invariance',
      'HTTP/PG coupon identity: automatic principal differs from standalone coupon benefit; Pricing offer and combination permissions preserved; evaluate/validate/retry never consume or write Inbox/Outbox',
      'HTTP/PG composition budgets and monetary failures yield contractual correlated 503 with no partial winner, invented currency scale or rounded unit-price fallback',
    ];
  } finally {
    await app?.close();
    if (ids.length) await deactivate();
  }
}
