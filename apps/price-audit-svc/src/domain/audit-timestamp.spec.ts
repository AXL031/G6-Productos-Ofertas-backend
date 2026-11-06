import { describe, expect, it } from 'vitest';
import { validAuditTimestamp } from './audit-timestamp.js';

describe('Instantes de auditoría sin normalización de calendario', () => {
  it.each([
    '2024-02-29T23:59:59.123456Z',
    '2000-02-29T00:00:00Z',
    '2026-01-01T00:00:00+14:00',
    '2026-12-31T23:59:59-05:00',
  ])('acepta calendario válido y cambio de día por offset: %s', (value) => {
    expect(validAuditTimestamp(value)).toBe(true);
  });
  it.each([
    null,
    0,
    '1900-02-29T00:00:00Z',
    '2026-02-30T00:00:00-05:00',
    '2026-01-01T24:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+00:60',
    '2026-01-01T00:00:00',
  ])('rechaza fechas inexistentes o sin zona: %s', (value) => {
    expect(validAuditTimestamp(value)).toBe(false);
  });
});
