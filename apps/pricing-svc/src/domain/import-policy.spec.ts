import {
  finishRow,
  importDecision,
  startImport,
  startRow,
} from './import-policy.js';

describe('SPEC §6 / HU CA-10: decisiones locales de importación', () => {
  it.each([false, true])(
    'confirma todas las filas válidas, allow_partial=%s',
    (allowPartial) => {
      expect(importDecision(allowPartial, [true, true])).toEqual({
        commitRows: [true, true],
        status: 'COMPLETED',
        completedRows: 2,
        failedRows: 0,
      });
    },
  );
  it('sin parcial, un rechazo impide confirmar cualquier fila', () => {
    expect(importDecision(false, [true, false])).toEqual({
      commitRows: [false, false],
      status: 'FAILED',
      completedRows: 0,
      failedRows: 2,
    });
  });
  it('con parcial permite únicamente las válidas; todas inválidas da FAILED', () => {
    expect(importDecision(true, [true, false])).toEqual({
      commitRows: [true, false],
      status: 'PARTIAL',
      completedRows: 1,
      failedRows: 1,
    });
    expect(importDecision(true, [false])).toMatchObject({
      status: 'FAILED',
      completedRows: 0,
      failedRows: 1,
    });
  });
  it('cero filas respeta contadores del modelo sin inventar mínimo de archivo', () => {
    expect(importDecision(false, [])).toEqual({
      commitRows: [],
      status: 'COMPLETED',
      completedRows: 0,
      failedRows: 0,
    });
  });
  it('estados de lote y fila progresan y no reviven terminales', () => {
    expect(startImport('QUEUED')).toBe('PROCESSING');
    for (const status of [
      'PROCESSING',
      'COMPLETED',
      'PARTIAL',
      'FAILED',
    ] as const)
      expect(startImport(status)).toBe(status);
    expect(startRow('PENDING')).toBe('PROCESSING');
    for (const status of ['PROCESSING', 'COMPLETED', 'FAILED'] as const)
      expect(startRow(status)).toBe(status);
  });
  it('resultado de fila idéntico es idempotente; contradictorio falla', () => {
    for (const result of ['COMPLETED', 'FAILED'] as const) {
      expect(finishRow('PROCESSING', result)).toBe(result);
      expect(finishRow(result, result)).toBe(result);
      expect(() => finishRow('PENDING', result)).toThrow('VALIDACION');
    }
    expect(() => finishRow('COMPLETED', 'FAILED')).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(() => finishRow('FAILED', 'COMPLETED')).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  });
});
