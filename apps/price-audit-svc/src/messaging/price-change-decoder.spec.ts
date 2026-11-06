import { describe, expect, it } from 'vitest';
import { decodePriceChange, percentage } from './price-change-decoder.js';

const at = new Date('2026-11-02T12:00:00Z');
const event = () => ({
  target_type: 'SKU',
  product_id: 'p1',
  sku: '0001',
  channel_id: null,
  currency: 'PEN',
  price_type: 'REGULAR',
  previous_price: '80',
  new_price: '81',
  operation: 'MODIFICACION',
  reason: 'Ajuste',
  price_version: 2,
  valid_from: '2026-10-01T00:00:00Z',
  batch_id: null,
  actor: { user_id: null, email: null, ip: null },
});
describe('DEC-G6-INT-06 — decoder productivo', () => {
  it.each([
    ['80', '81', '1.25'],
    ['6', '7', '16.67'],
    ['6', '5', '-16.67'],
    ['20000', '20001', '0.01'],
    ['20000', '19999', '-0.01'],
    ['999999999999999999999', '1000000000000000000000', '0.00'],
    ['0', '1', null],
    [null, '1', null],
    ['1', null, null],
  ])('porcentaje exacto %s → %s', (previous, next, expected) => {
    expect(percentage(previous, next)).toBe(expected);
  });
  it('conserva identidad opaca, canal global y timestamp del hecho, no valid_from', () => {
    expect(decodePriceChange(event(), at)[0]).toMatchObject({
      targetType: 'SKU',
      sku: '0001',
      channel: null,
      at,
      variation: '1.25',
    });
  });
  it('acepta producto sin inventar SKU y conserva actor', () => {
    expect(
      decodePriceChange(
        {
          ...event(),
          target_type: 'PRODUCTO',
          sku: null,
          operation: 'CREACION',
          previous_price: null,
          actor: { user_id: 'actor', email: 'a@example.com', ip: '::1' },
        },
        at,
      )[0],
    ).toMatchObject({
      targetType: 'PRODUCTO',
      sku: null,
      variation: null,
      userId: 'actor',
      email: 'a@example.com',
      ip: '::1',
    });
  });
  it('retiro de oferta conserva nulos', () => {
    expect(
      decodePriceChange(
        {
          ...event(),
          price_type: 'OFERTA',
          operation: 'RETIRO_OFERTA',
          new_price: null,
        },
        at,
      )[0],
    ).toMatchObject({
      next: null,
      variation: null,
      operation: 'RETIRO_OFERTA',
    });
  });
  it.each([
    { valid_from: '2026-02-30T00:00:00Z' },
    { valid_from: '2026-02-29T23:00:00-05:00' },
    { valid_from: '2026-04-31T12:00:00Z' },
    { valid_from: '2026-11-05T24:00:00Z' },
    { target_type: 'PRODUCTO' },
    { sku: null },
    { sku: '' },
    { channel_id: 'GLOBAL' },
    { currency: 'P' },
    { price_version: 0 },
    { valid_from: 'yesterday' },
    { batch_id: 'invalid' },
    { previous_price: 'NaN' },
    { new_price: 10 },
    { new_price: '0' },
    { operation: 'CREACION' },
    { operation: 'RETIRO_OFERTA', new_price: null },
    { new_price: '80.00' },
    { actor: {} },
    { actor: null },
    { extra: true },
  ])('rechaza sin sintetizar: %j', (changes) => {
    expect(() => decodePriceChange({ ...event(), ...changes }, at)).toThrow(
      'VALIDACION',
    );
  });
  it('rechaza GenericData y campos obligatorios ausentes', () => {
    expect(() => decodePriceChange({}, at)).toThrow();
    for (const key of Object.keys(event())) {
      const data: Record<string, unknown> = event();
      delete data[key];
      expect(() => decodePriceChange(data, at)).toThrow();
    }
  });
});
