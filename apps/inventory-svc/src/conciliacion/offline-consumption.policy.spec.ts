import { describe, expect, it } from 'vitest';
import { planOfflineConsumption } from './offline-consumption.policy.js';

describe('Conciliación offline — invariantes internas DEC-F-013', () => {
  it('aplica solo unidades libres y conserva el resto para revisión', () => {
    const balance = Object.freeze({ onHand: 10, reserved: 3, blocked: 2 });
    expect(planOfflineConsumption(balance, 8)).toEqual({
      onHand: 5,
      appliedQuantity: 5,
      unresolvedQuantity: 3,
      requiresReview: true,
      recordMovement: true,
    });
    expect(balance).toEqual({ onHand: 10, reserved: 3, blocked: 2 });
  });

  it('cero unidades disponibles no genera movimiento de cantidad cero', () => {
    expect(
      planOfflineConsumption({ onHand: 5, reserved: 3, blocked: 2 }, 1),
    ).toEqual({
      onHand: 5,
      appliedQuantity: 0,
      unresolvedQuantity: 1,
      requiresReview: true,
      recordMovement: false,
    });
  });

  it('preserva todas las invariantes en consumos totales, parciales y sin saldo libre', () => {
    for (let onHand = 0; onHand <= 12; onHand++) {
      for (let reserved = 0; reserved <= onHand; reserved++) {
        for (let blocked = 0; blocked <= onHand - reserved; blocked++) {
          for (const quantity of [1, 4, 20]) {
            const result = planOfflineConsumption(
              { onHand, reserved, blocked },
              quantity,
            );
            expect(result.onHand).toBeGreaterThanOrEqual(reserved + blocked);
            expect(result.appliedQuantity + result.unresolvedQuantity).toBe(
              quantity,
            );
            expect(onHand - result.onHand).toBe(result.appliedQuantity);
            expect(result.appliedQuantity).toBeLessThanOrEqual(quantity);
            expect(result.requiresReview).toBe(result.unresolvedQuantity > 0);
          }
        }
      }
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rechaza cantidades no representables: %s', (quantity) => {
    expect(() =>
      planOfflineConsumption({ onHand: 10, reserved: 0, blocked: 0 }, quantity),
    ).toThrow(RangeError);
  });

  it.each([
    { onHand: -1, reserved: 0, blocked: 0 },
    { onHand: 1, reserved: 1, blocked: 1 },
    { onHand: 3.5, reserved: 0, blocked: 0 },
  ])(
    'rechaza saldos inconsistentes sin encubrirlos con available=0: %j',
    (balance) => {
      expect(() => planOfflineConsumption(balance, 1)).toThrow(RangeError);
    },
  );
});
