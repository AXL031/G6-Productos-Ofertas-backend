import { BulkDomainError } from './bulk.errors.js';

export type WorkflowDomain = 'CATALOGO' | 'PRICING' | 'INVENTARIO';
export type WorkflowStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export function nextDomains(input: {
  required: WorkflowDomain[];
  confirmed: WorkflowDomain[];
  failed?: WorkflowDomain | null;
}): WorkflowDomain[] {
  if (input.failed === 'CATALOGO') return [];
  if (!input.confirmed.includes('CATALOGO')) return ['CATALOGO'];
  return input.required.filter(
    (domain) => !input.confirmed.includes(domain) && domain !== input.failed,
  );
}

export function assertStepTransition(
  previous: WorkflowStatus,
  next: WorkflowStatus,
): void {
  if (previous === 'COMPLETED' && next !== 'COMPLETED') {
    throw new BulkDomainError(
      'INVALID_TRANSITION',
      'Un dominio confirmado no puede retroceder.',
    );
  }
}

export function assertRowCompletion(
  required: WorkflowDomain[],
  confirmed: WorkflowDomain[],
): void {
  if (required.some((domain) => !confirmed.includes(domain))) {
    throw new BulkDomainError(
      'DEPENDENCY_PENDING',
      'La fila requiere confirmar todos sus dominios obligatorios.',
    );
  }
}

export function isBatchComplete(
  rows: Array<{ status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' }>,
): boolean {
  return rows.every(
    (row) => row.status === 'COMPLETED' || row.status === 'FAILED',
  );
}

export function isInventoryStepComplete(input: {
  vendibleSkuCount: number;
  confirmedSkuInitializations: number;
  stockAdjustmentRequired: boolean;
  stockAdjustmentConfirmed: boolean;
}): boolean {
  return (
    input.vendibleSkuCount > 0 &&
    Number.isInteger(input.confirmedSkuInitializations) &&
    input.confirmedSkuInitializations === input.vendibleSkuCount &&
    (!input.stockAdjustmentRequired || input.stockAdjustmentConfirmed)
  );
}
