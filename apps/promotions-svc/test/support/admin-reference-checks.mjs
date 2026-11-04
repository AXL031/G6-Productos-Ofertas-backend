import assert from 'node:assert/strict';

// Contract of the INTERNAL AdminReferences port only. There is no authorized
// external wire adapter yet; these facts are explicit test fixtures, never DI
// providers in the production module. All HTTP writes/SQL below are real.
export async function verifyAdminReferenceBoundary({
  call,
  pool,
  promotion,
  recommendation,
  setVerifier,
}) {
  const facts = () => ({
    products: new Set(['WRITE-P', 'WRITE-TARGET']),
    skus: new Set(['WRITE-SKU']),
    categories: new Set(['WRITE-CATEGORY']),
  });
  const snapshot = async () => {
    const result = [];
    for (const table of [
      'promotions',
      'promotion_scopes',
      'combination_policy',
      'recommendation_rules',
      'recommendation_items',
      'coupon_uses',
      'coupon_command_receipts',
      'inbox',
      'outbox',
    ]) {
      const rows = await pool.query(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM promotions.${table} t`,
      );
      result.push([table, rows.rows[0].rows]);
    }
    return result;
  };
  const cases = [
    {
      kind: 'products',
      reference: 'WRITE-P',
      create: 'crearPromocion',
      update: 'actualizarPromocion',
      activate: 'activarPromocion',
      path: '/api/v1/promociones',
      key: 'promotionId',
      body: {
        ...promotion,
        nombre: 'REFERENCE-P',
        alcance: { productIds: ['WRITE-P'] },
      },
    },
    {
      kind: 'skus',
      reference: 'WRITE-SKU',
      create: 'crearPromocion',
      update: 'actualizarPromocion',
      activate: 'activarPromocion',
      path: '/api/v1/promociones',
      key: 'promotionId',
      body: {
        ...promotion,
        nombre: 'REFERENCE-SKU',
        alcance: { skus: ['WRITE-SKU'] },
      },
    },
    {
      kind: 'categories',
      reference: 'WRITE-CATEGORY',
      create: 'crearReglaRecomendacion',
      update: 'actualizarReglaRecomendacion',
      activate: 'activarReglaRecomendacion',
      path: '/api/v1/recomendaciones/reglas',
      key: 'reglaId',
      body: {
        ...recommendation,
        nombre: 'REFERENCE-CATEGORY',
        origen: { tipo: 'CATEGORIA', id: 'WRITE-CATEGORY' },
      },
    },
  ];
  try {
    for (const test of cases) {
      setVerifier(async () => facts());
      const saved = await call(test.create, test.path, test.body, 201);
      const path = `${test.path}/${saved[test.key]}`;
      const before = await snapshot();
      for (const failure of [
        'nonexistent',
        'inactive',
        'inconsistent',
        'timeout',
      ]) {
        let calls = 0;
        let signal;
        setVerifier(async (request, abort) => {
          calls++;
          signal = abort;
          assert.deepEqual(request[test.kind], [test.reference]);
          if (failure === 'timeout') return new Promise(() => {});
          const active = facts();
          // Nonexistent and inactive identities are both absent from the
          // verified ACTIVE set. Inconsistent facts return another identity.
          active[test.kind] = new Set(
            failure === 'inconsistent' ? ['UNRELATED-IDENTITY'] : [],
          );
          return active;
        });
        for (const [operation, target, body] of [
          [test.create, test.path, test.body],
          [test.update, path, { nombre: 'MUST-NOT-PERSIST' }],
          [test.activate, `${path}/activar`, undefined],
        ]) {
          // Activation operations publish no 422 response in OpenAPI rc.1;
          // unresolved reference rules therefore remain fail-closed with 503.
          const expected =
            failure === 'timeout' || operation === test.activate ? 503 : 422;
          await call(operation, target, body, expected);
          assert.equal(signal.aborted, failure === 'timeout');
          assert.deepEqual(
            await snapshot(),
            before,
            `${test.kind}/${failure}/${operation}: zero durable effects`,
          );
        }
        assert.equal(calls, 3);
      }
    }
  } finally {
    setVerifier(undefined);
  }
  return 'administrative reference port: products/SKU/categories missing, inactive, inconsistent and timed out reject create/patch/activate with unchanged real SQL aggregates and messaging; timeout aborts the port';
}
