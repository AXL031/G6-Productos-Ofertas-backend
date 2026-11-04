import { describe, expect, it } from 'vitest';
import {
  assertArchiveVerified,
  assertExportLimit,
  validateChange,
  type AuditChange,
} from './audit.js';
const change: AuditChange = {
  sku: 'SKU-1',
  productId: 'product-1',
  priceType: 'REGULAR',
  previous: null,
  next: '12.30',
  variation: null,
  operation: 'CREACION',
  channel: 'GLOBAL',
  reason: 'ALTA_PRODUCTO',
  batchId: null,
  userId: null,
  email: null,
  ip: null,
  at: new Date('2026-10-01T00:00:00Z'),
};
describe('Invariantes de la bitácora', () => {
  it.each([
    {},
    { operation: 'MODIFICACION', previous: '10.00', variation: '23' },
    {
      operation: 'RETIRO_OFERTA',
      priceType: 'OFERTA',
      previous: '5',
      next: null,
    },
    { next: '0' },
    { next: '1.001' },
    { operation: 'MODIFICACION', previous: '0', variation: null },
  ])('preserva semántica aprobada, incluido cero real: %j', (values) => {
    const input = { ...change, ...values } as AuditChange;
    expect(validateChange(input)).toEqual(input);
  });
  it.each([
    { previous: '0' },
    { next: null },
    { next: '-1' },
    { next: 'NaN' },
    { reason: '  ' },
    { sku: '' },
    { at: new Date('invalid') },
    { operation: 'MODIFICACION', previous: '10', variation: null },
    { operation: 'RETIRO_OFERTA', previous: '10', next: null },
    { batchId: 'not-uuid' },
    { variation: 'Infinity' },
  ])('rechaza un asiento incoherente: %j', (values) => {
    expect(() =>
      validateChange({ ...change, ...values } as AuditChange),
    ).toThrow();
  });
  it('proyecta solo campos de negocio y no acepta PK/inbox del decoder', () => {
    expect(
      validateChange({
        ...change,
        id: 'spoofed',
        inboxId: 'spoofed',
      } as AuditChange),
    ).not.toHaveProperty('id');
  });
  it.each([
    ['CSV', 100000],
    ['PDF', 500],
  ] as const)('admite el límite inclusivo de %s', (format, count) => {
    expect(() => assertExportLimit(format, count)).not.toThrow();
    expect(() => assertExportLimit(format, count + 1)).toThrowError(
      'LIMITE_EXPORTACION_AUDITORIA_EXCEDIDO',
    );
  });
  it('impide retirar originales sin prueba de recuperabilidad', () => {
    const verified = {
      recordCount: 10,
      verifiedCount: 10,
      checksum: 'checksum',
      verifiedChecksum: 'checksum',
      verifiedAt: new Date(),
      recoverable: true,
    };
    expect(() => assertArchiveVerified(verified, 10, 'checksum')).not.toThrow();
    for (const override of [
      { recoverable: false },
      { verifiedCount: 9 },
      { verifiedChecksum: 'other' },
      { verifiedAt: null },
    ]) {
      expect(() =>
        assertArchiveVerified({ ...verified, ...override }, 10, 'checksum'),
      ).toThrow();
    }
    expect(() => assertArchiveVerified(verified, 9, 'checksum')).toThrow();
  });
});
