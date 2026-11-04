import type { Request } from 'express';
import { httpContracts } from './http-contract.generated.js';
import { queryInput, valid } from './http-validation.js';
describe('Official Promotions HTTP schemas', () => {
  it('includes the ten queries and twelve authorized administrative operationIds', () => {
    expect(Object.keys(httpContracts)).toHaveLength(22);
    expect(
      Object.values(httpContracts)
        .filter(
          (c) => c.method === 'POST' && c.security.includes('serviceBearer'),
        )
        .map((c) => c.path)
        .sort(),
    ).toEqual(['/api/v1/cupones/validar', '/api/v1/promociones/evaluar']);
    expect(
      Object.entries(httpContracts).filter(([id]) =>
        /^(crear|actualizar|activar|desactivar)/.test(id),
      ),
    ).toHaveLength(12);
    for (const [id, c] of Object.entries(httpContracts))
      if (/^(crear|actualizar|activar|desactivar)/.test(id))
        expect(c.security).toEqual(['userBearer']);
  });
  it.each([
    { lines: [] },
    { lines: [{ sku: 'SKU', quantity: 0 }] },
    { lines: [{ sku: 'SKU', quantity: 1.5 }] },
    { channel_id: 'UNKNOWN' },
    { at: '2026-02-30T12:00:00Z' },
    { customer_ref: 'not-uuid' },
  ])('rejects invalid request %j', (changes) => {
    expect(
      valid(
        {
          channel_id: 'MARKETPLACE',
          lines: [{ sku: 'SKU', quantity: 1 }],
          ...changes,
        },
        httpContracts.evaluarPromociones.body!,
      ),
    ).toBe(false);
  });
  it('uses exact query defaults, boundaries and explicit boolean parsing', () => {
    expect(queryInput({}, httpContracts.listarCupones)).toEqual({
      pagina: 1,
      tamanio: 20,
    });
    expect(
      queryInput(
        { canal: 'MARKETPLACE', vigentes: 'false' },
        httpContracts.listarPromociones,
      ),
    ).toEqual({ canal: 'MARKETPLACE', vigentes: false });
    for (const q of [
      { pagina: '0' },
      { tamanio: '201' },
      { pagina: '1.1' },
      { estado: 'ACTIVA' },
      { pagina: ['1', '2'] },
    ])
      expect(() =>
        queryInput(q as Request['query'], httpContracts.listarCupones),
      ).toThrow('VALIDACION');
  });
  it('requires stable rejection codes only when the coupon is invalid', () => {
    const s = httpContracts.validarCupon.response;
    expect(
      valid(
        {
          valid: false,
          discount_amount: 0,
          result_amount: 10,
          currency: 'PEN',
        },
        s,
      ),
    ).toBe(false);
    expect(
      valid(
        {
          valid: false,
          code: 'CUPON_AGOTADO',
          discount_amount: 0,
          result_amount: 10,
          currency: 'PEN',
        },
        s,
      ),
    ).toBe(true);
    expect(
      valid(
        {
          valid: true,
          code: 'CUPON_AGOTADO',
          discount_amount: 1,
          result_amount: 9,
          currency: 'PEN',
        },
        s,
      ),
    ).toBe(false);
  });
});
