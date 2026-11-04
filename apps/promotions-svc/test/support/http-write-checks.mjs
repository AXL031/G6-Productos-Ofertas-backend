// Real signed HTTP + PostgreSQL/TLS. Only Catalog reference facts are synthetic.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PromotionsSvcModule } from '../../../../dist/apps/promotions-svc/promotions-svc.module.js';
import { PromotionsConfigService } from '../../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import { COUPON_RESOURCES } from '../../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import { ADMIN_REFERENCES } from '../../../../dist/apps/promotions-svc/domain/admin-references.js';
import { PROMOTIONS_JWKS } from '../../../../dist/apps/promotions-svc/http/promotions-identity.js';
import { httpContracts } from '../../../../dist/apps/promotions-svc/http/http-contract.generated.js';
import { valid } from '../../../../dist/apps/promotions-svc/http/http-validation.js';
import { verifyAdminReferenceBoundary } from './admin-reference-checks.mjs';

export async function verifyHttpWrites(resources, baseConfig, admin) {
  const checks = [];
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'isolated-write-key',
    alg: 'RS256',
    use: 'sig',
  };
  const issuer = 'https://isolated-write.test/auth';
  function token(changes = {}) {
    const now = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid: key.kid, typ: 'JWT' },
      {
        iss: issuer,
        sub: randomUUID(),
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...changes,
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
  }
  const user = token();
  const promotion = {
    nombre: 'WRITE-PROMOTION',
    tipoDescuento: 'PORCENTAJE',
    valor: 10,
    modalidad: 'CUPON',
    estado: 'INACTIVO',
    validFrom: '2026-10-01T00:00:00Z',
    validUntil: '2026-12-01T00:00:00Z',
    alcance: { productIds: ['WRITE-P'], skus: [] },
    prioridad: 1,
    canalesHabilitados: ['MARKETPLACE'],
    politicaCombinacion: {
      ofertaPricing: false,
      promocionAutomatica: false,
      cupon: false,
    },
  };
  const recommendation = {
    nombre: 'WRITE-RULE',
    tipo: 'CROSS_SELL',
    origen: { tipo: 'PRODUCTO', id: 'WRITE-ORIGIN' },
    prioridad: 1,
    estado: 'INACTIVO',
    validFrom: promotion.validFrom,
    validUntil: promotion.validUntil,
    recomendados: [{ productId: 'WRITE-TARGET', orden: 1 }],
  };
  let app;
  let refuseReferences = false;
  let referenceHook;
  let referenceVerifier;
  async function start(withReferences) {
    const builder = Test.createTestingModule({ imports: [PromotionsSvcModule] })
      .overrideProvider(PromotionsConfigService)
      .useValue(
        new PromotionsConfigService({
          ...baseConfig.settings,
          auth: { issuer, jwksUrl: 'https://isolated-write.test/jwks' },
        }),
      )
      .overrideProvider(COUPON_RESOURCES)
      .useValue({ ...resources, onApplicationShutdown: async () => undefined })
      .overrideProvider(PROMOTIONS_JWKS)
      .useValue(async () => [key]);
    if (withReferences)
      builder.overrideProvider(ADMIN_REFERENCES).useValue({
        verify: async (request, signal) => {
          if (referenceVerifier) return referenceVerifier(request, signal);
          if (refuseReferences)
            throw new Error('Synthetic unavailable Catalog');
          if (referenceHook) await referenceHook();
          return {
            products: new Set([
              'WRITE-P',
              'WRITE-Q',
              'WRITE-ORIGIN',
              'WRITE-TARGET',
            ]),
            skus: new Set(),
            categories: new Set(['WRITE-CATEGORY']),
          };
        },
      });
    const module = await builder.compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    return async (id, path, body, expected, bearer = user) => {
      const trace = randomUUID();
      const response = await fetch(base + path, {
        method: httpContracts[id].method,
        headers: {
          'X-Correlation-Id': trace,
          ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(9000),
      });
      const data = await response.json();
      assert.ok(
        (Array.isArray(expected) ? expected : [expected]).includes(
          response.status,
        ),
        `${id}: HTTP ${response.status} ${JSON.stringify(data)}`,
      );
      if (response.status < 300)
        assert.equal(
          valid(data, httpContracts[id].response),
          true,
          `${id} official response`,
        );
      else {
        assert.match(
          response.headers.get('content-type'),
          /^application\/problem\+json/,
        );
        assert.equal(data.correlationId, trace);
        assert.ok(
          httpContracts[id].errors[String(response.status)].includes(data.code),
        );
        assert.equal(
          JSON.stringify(data).includes(baseConfig.settings.database.password),
          false,
        );
      }
      return data;
    };
  }
  const effects = async () =>
    (
      await resources.pool.query(
        'SELECT (SELECT count(*)::int FROM promotions.coupon_uses) uses, (SELECT count(*)::int FROM promotions.coupon_command_receipts) receipts, (SELECT count(*)::int FROM promotions.inbox) inbox, (SELECT count(*)::int FROM promotions.outbox) outbox',
      )
    ).rows;
  try {
    const beforeEffects = await effects();
    let call = await start(false);
    const count = async () =>
      (
        await resources.pool.query(
          'SELECT count(*)::int n FROM promotions.promotions',
        )
      ).rows[0].n;
    const beforeCount = await count();
    await call('crearPromocion', '/api/v1/promociones', promotion, 503);
    await call(
      'crearReglaRecomendacion',
      '/api/v1/recomendaciones/reglas',
      recommendation,
      503,
    );
    assert.equal(await count(), beforeCount);
    for (const [id, contract] of Object.entries(httpContracts))
      if (/^(crear|actualizar|activar|desactivar)/.test(id)) {
        const path = contract.path.replace(/\{[^}]+\}/g, randomUUID());
        await call(id, path, undefined, 401, '');
        await call(id, path, undefined, 403, token({ roles: ['CONSULTOR'] }));
        await call(
          id,
          path,
          undefined,
          403,
          token({
            tipo: 'servicio',
            sub: 'modulo-marketplace',
            aud: ['api-productos'],
            scope: 'promociones:leer',
          }),
        );
      }
    await call('crearPromocion', '/api/v1/promociones', '{broken', 400);
    await call(
      'crearPromocion',
      '/api/v1/promociones',
      { ...promotion, canalesHabilitados: [] },
      400,
    );
    await call(
      'crearPromocion',
      '/api/v1/promociones',
      { ...promotion, valor: 101 },
      422,
    );
    await call(
      'crearPromocion',
      '/api/v1/promociones',
      { ...promotion, alcance: {} },
      422,
    );
    checks.push(
      'HTTP writes fail closed without Catalog references, validate input and enforce signed user roles on all 12 operations; service tokens cannot administer',
    );
    await app.close();
    app = undefined;
    call = await start(true);
    const created = await call(
      'crearPromocion',
      '/api/v1/promociones',
      {
        ...promotion,
        puedeCambiarModalidad: false,
        firstActivatedAt: 'forged',
      },
      201,
    );
    const p = created.promotionId;
    assert.equal(created.puedeCambiarModalidad, true);
    await call(
      'actualizarPromocion',
      '/api/v1/promociones/' + p,
      { alcance: { productIds: ['WRITE-INACTIVE'] } },
      422,
    );
    const updated = await call(
      'actualizarPromocion',
      '/api/v1/promociones/' + p,
      {
        alcance: { productIds: ['WRITE-Q'] },
        politicaCombinacion: {
          ...promotion.politicaCombinacion,
          ofertaPricing: true,
        },
      },
      200,
    );
    assert.deepEqual(updated.alcance.productIds, ['WRITE-Q']);
    assert.equal(updated.canalesHabilitados[0], 'MARKETPLACE');
    assert.equal(updated.politicaCombinacion.ofertaPricing, true);
    const concurrent = await Promise.all([
      call(
        'actualizarPromocion',
        '/api/v1/promociones/' + p,
        { nombre: 'WRITE-CONCURRENT' },
        200,
      ),
      call(
        'actualizarPromocion',
        '/api/v1/promociones/' + p,
        { prioridad: 2 },
        200,
      ),
    ]);
    assert.equal(concurrent.length, 2);
    const afterConcurrent = (
      await resources.pool.query(
        'SELECT name,priority FROM promotions.promotions WHERE id=$1',
        [p],
      )
    ).rows[0];
    assert.deepEqual(afterConcurrent, {
      name: 'WRITE-CONCURRENT',
      priority: 2,
    });
    await call(
      'activarPromocion',
      `/api/v1/promociones/${p}/activar`,
      undefined,
      200,
    );
    const firstActivation = (
      await resources.pool.query(
        'SELECT first_activated_at FROM promotions.promotions WHERE id=$1',
        [p],
      )
    ).rows[0].first_activated_at;
    refuseReferences = true;
    await call(
      'desactivarPromocion',
      `/api/v1/promociones/${p}/desactivar`,
      undefined,
      200,
    );
    await call(
      'activarPromocion',
      `/api/v1/promociones/${p}/activar`,
      undefined,
      503,
    );
    refuseReferences = false;
    await call(
      'actualizarPromocion',
      '/api/v1/promociones/' + p,
      { modalidad: 'AUTOMATICA', puedeCambiarModalidad: true },
      422,
    );
    await call(
      'activarPromocion',
      `/api/v1/promociones/${p}/activar`,
      undefined,
      200,
    );
    assert.equal(
      (
        await resources.pool.query(
          'SELECT first_activated_at FROM promotions.promotions WHERE id=$1',
          [p],
        )
      ).rows[0].first_activated_at.getTime(),
      firstActivation.getTime(),
    );
    checks.push(
      'promotion create/patch/state writes preserve scope/policy, serialize concurrent patches, derive modality capability and keep first activation immutable; deactivation works during Catalog outage',
    );

    const couponBody = {
      codigo: 'write_coupon',
      promocionId: p,
      estado: 'ACTIVO',
      montoMinimo: 0.001,
      maxUsosGlobal: null,
      maxUsosPorCliente: null,
      politicaCancelacion: 'RESTAURAR_EN_CANCELACION',
    };
    const coupon = await call('crearCupon', '/api/v1/cupones', couponBody, 201);
    assert.equal(coupon.codigo, 'WRITE_COUPON');
    const c = coupon.cuponId;
    await call(
      'crearCupon',
      '/api/v1/cupones',
      { ...couponBody, codigo: 'WRITE_COUPON' },
      409,
    );
    const edited = await call(
      'actualizarCupon',
      '/api/v1/cupones/' + c,
      { codigo: 'write_coupon', montoMinimo: null, maxUsosGlobal: 3 },
      200,
    );
    assert.equal(edited.montoMinimo, null);
    assert.equal(edited.maxUsosGlobal, 3);
    await call(
      'actualizarCupon',
      '/api/v1/cupones/' + c,
      { promocionId: 'invalid-id' },
      422,
    );
    await call(
      'desactivarCupon',
      `/api/v1/cupones/${c}/desactivar`,
      undefined,
      200,
    );
    await call('activarCupon', `/api/v1/cupones/${c}/activar`, undefined, 200);
    const race = await Promise.all(
      [0, 1].map(() =>
        call(
          'crearCupon',
          '/api/v1/cupones',
          { ...couponBody, codigo: 'WRITE_RACE' },
          [201, 409],
        ),
      ),
    );
    assert.equal(race.filter((r) => r.code === 'CUPON_DUPLICADO').length, 1);
    assert.equal(
      (
        await resources.pool.query(
          "SELECT count(*)::int n FROM promotions.coupons WHERE code='WRITE_RACE'",
        )
      ).rows[0].n,
      1,
    );
    checks.push(
      'coupon writes normalize codes, preserve nullable limits, enforce parent modality and unique codes under concurrent create; activate/deactivate never consume',
    );

    const rule = await call(
      'crearReglaRecomendacion',
      '/api/v1/recomendaciones/reglas',
      recommendation,
      201,
    );
    const ruleId = rule.reglaId;
    await call(
      'actualizarReglaRecomendacion',
      '/api/v1/recomendaciones/reglas/' + ruleId,
      { tipo: 'UPSELL' },
      422,
    );
    const upsell = await call(
      'actualizarReglaRecomendacion',
      '/api/v1/recomendaciones/reglas/' + ruleId,
      {
        tipo: 'UPSELL',
        recomendados: [
          {
            productId: 'WRITE-TARGET',
            orden: 2,
            criterioSuperioridad: 'MAYOR_CAPACIDAD',
            justificacionComercial: 'Explicit synthetic test',
          },
        ],
      },
      200,
    );
    assert.equal(upsell.recomendados[0].orden, 2);
    await call(
      'actualizarReglaRecomendacion',
      '/api/v1/recomendaciones/reglas/' + ruleId,
      {
        recomendados: [
          {
            productId: 'WRITE-INACTIVE',
            orden: 1,
            criterioSuperioridad: 'MAYOR_CAPACIDAD',
          },
        ],
      },
      422,
    );
    await call(
      'activarReglaRecomendacion',
      `/api/v1/recomendaciones/reglas/${ruleId}/activar`,
      undefined,
      200,
    );
    refuseReferences = true;
    await call(
      'desactivarReglaRecomendacion',
      `/api/v1/recomendaciones/reglas/${ruleId}/desactivar`,
      undefined,
      200,
    );
    refuseReferences = false;
    await call(
      'activarReglaRecomendacion',
      `/api/v1/recomendaciones/reglas/${ruleId}/activar`,
      undefined,
      200,
    );
    checks.push(
      'recommendation create/patch/state writes validate active origins/targets, explicit UPSELL criteria and ordered aggregate replacement',
    );

    checks.push(
      await verifyAdminReferenceBoundary({
        call,
        pool: resources.pool,
        promotion,
        recommendation,
        setVerifier: (verify) => {
          referenceVerifier = verify;
        },
      }),
    );

    // A real deferred PostgreSQL failure after replacing children must undo the
    // parent and every child. Test-only DDL lives only in this disposable DB.
    await admin.query(`CREATE FUNCTION promotions.test_write_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ISOLATED_DEFERRED_FAILURE'; END $$;
      CREATE CONSTRAINT TRIGGER test_write_rollback AFTER UPDATE ON promotions.promotions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.name='WRITE_FORCE_ROLLBACK') EXECUTE FUNCTION promotions.test_write_rollback();`);
    const prior = (
      await resources.pool.query(
        'SELECT name,priority FROM promotions.promotions WHERE id=$1',
        [p],
      )
    ).rows;
    const children = (
      await resources.pool.query(
        'SELECT id,product_id,sku FROM promotions.promotion_scopes WHERE promotion_id=$1 ORDER BY id',
        [p],
      )
    ).rows;
    await call(
      'actualizarPromocion',
      '/api/v1/promociones/' + p,
      { nombre: 'WRITE_FORCE_ROLLBACK', alcance: { productIds: ['WRITE-P'] } },
      503,
    );
    assert.deepEqual(
      (
        await resources.pool.query(
          'SELECT name,priority FROM promotions.promotions WHERE id=$1',
          [p],
        )
      ).rows,
      prior,
    );
    assert.deepEqual(
      (
        await resources.pool.query(
          'SELECT id,product_id,sku FROM promotions.promotion_scopes WHERE promotion_id=$1 ORDER BY id',
          [p],
        )
      ).rows,
      children,
    );
    await admin.query(
      'DROP TRIGGER test_write_rollback ON promotions.promotions; DROP FUNCTION promotions.test_write_rollback();',
    );
    // Change the reference set after the verification call but before locking.
    referenceHook = async () => {
      referenceHook = undefined;
      await resources.pool.query(
        'UPDATE promotions.promotion_scopes SET product_id=$2 WHERE promotion_id=$1',
        [p, 'WRITE-P'],
      );
    };
    await call(
      'actualizarPromocion',
      '/api/v1/promociones/' + p,
      { nombre: 'STALE-REFERENCES' },
      503,
    );
    assert.deepEqual(
      (
        await resources.pool.query(
          'SELECT name,priority FROM promotions.promotions WHERE id=$1',
          [p],
        )
      ).rows,
      prior,
    );
    for (const [id, path] of [
      ['actualizarPromocion', '/api/v1/promociones/'],
      ['actualizarCupon', '/api/v1/cupones/'],
      ['actualizarReglaRecomendacion', '/api/v1/recomendaciones/reglas/'],
    ]) {
      await call(id, path + randomUUID(), {}, 404);
      await call(id, path + 'opaque-id', {}, 404);
    }
    assert.deepEqual(await effects(), beforeEffects);
    checks.push(
      'deferred real DB failure rolls back parent/children, stale reference verification fails safely, missing/opaque IDs return 404 and administrative writes create no uses/receipts/Inbox/Outbox',
    );
    return checks;
  } finally {
    await app?.close();
  }
}
