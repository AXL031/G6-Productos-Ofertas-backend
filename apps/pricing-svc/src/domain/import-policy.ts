import { requireRule } from './price.js';

export type ImportRowStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type ImportStatus =
  'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export function startImport(status: ImportStatus): ImportStatus {
  return status === 'QUEUED' ? 'PROCESSING' : status;
}

export function startRow(status: ImportRowStatus): ImportRowStatus {
  return status === 'PENDING' ? 'PROCESSING' : status;
}

export function finishRow(
  current: ImportRowStatus,
  result: 'COMPLETED' | 'FAILED',
): ImportRowStatus {
  if (current === 'COMPLETED' || current === 'FAILED') {
    requireRule(current === result, 'IDEMPOTENCY_CONFLICT');
    return current;
  }
  requireRule(current === 'PROCESSING', 'VALIDACION');
  return result;
}

// Recibe resultados prevalidados, no define formato de archivo ni atomicidad remota.
export function importDecision(
  allowPartial: boolean,
  validRows: readonly boolean[],
) {
  const failed = validRows.filter((valid) => !valid).length;
  const commitRows = validRows.map(
    (valid) => valid && (allowPartial || failed === 0),
  );
  const completedRows = commitRows.filter(Boolean).length;
  const status: ImportStatus =
    failed === 0 ? 'COMPLETED' : completedRows > 0 ? 'PARTIAL' : 'FAILED';
  return {
    commitRows,
    status,
    completedRows,
    failedRows: validRows.length - completedRows,
  };
}
