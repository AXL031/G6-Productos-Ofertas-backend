import { describe, expect, it } from 'vitest';
import { wireAudit } from './audit.controller.js';
import type { auditLog } from '../persistence/audit.schema.js';

const row: typeof auditLog.$inferSelect = {
  id: 'audit',
  inboxId: 'inbox',
  targetType: 'SKU',
  sku: '0001',
  productId: 'p',
  priceType: 'REGULAR',
  previous: null,
  next: '0',
  variation: null,
  operation: 'CREACION',
  channel: 'MARKETPLACE',
  reason: 'Alta',
  batchId: null,
  userId: null,
  email: null,
  ip: null,
  at: new Date('2026-11-02T00:00:00Z'),
  createdAt: new Date('2026-11-02T00:00:00Z'),
};

describe('Proyección HTTP de importes PostgreSQL', () => {
  it.each([
    '0',
    '0.10000000000000000001',
    '9007199254740993.01',
    '9999999999999999999999999999.99',
    '1.2300',
  ])('serializa %s como número JSON exacto', (value) => {
    const json = JSON.stringify(
      wireAudit({
        ...row,
        previous: value,
        next: value,
        variation: '-' + value,
      }),
    );
    expect(json).toContain(`"precio_anterior":${value},`);
    expect(json).toContain(`"precio_nuevo":${value},`);
    expect(json).toContain(`"variacion_porcentual":-${value},`);
    expect(() => JSON.parse(json)).not.toThrow();
  });
  it('conserva null y cero como valores distintos', () => {
    const json = JSON.stringify(wireAudit(row));
    expect(JSON.parse(json)).toMatchObject({
      precio_anterior: null,
      precio_nuevo: 0,
      variacion_porcentual: null,
    });
  });
  it.each(['NaN', 'Infinity', '1e2', '01', '1,"injected":true', ''])(
    'rechaza numeric inválido %s sin inyección JSON',
    (value) => {
      expect(() => wireAudit({ ...row, next: value })).toThrow('ERROR_INTERNO');
    },
  );
});
