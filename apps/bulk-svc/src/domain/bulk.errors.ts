import { BulkPersistenceError } from '../persistence/bulk.persistence.errors.js';
import { BulkDomainError } from './bulk.domain-error.js';

export { BulkDomainError } from './bulk.domain-error.js';

export function mapBulkPersistenceError(error: unknown): BulkDomainError {
  if (error instanceof BulkDomainError) return error;
  if (error instanceof BulkPersistenceError) {
    return new BulkDomainError(
      error.code === 'UNIQUE_CONFLICT'
        ? 'IDEMPOTENCY_CONFLICT'
        : 'PERSISTENCE_FAILURE',
      error.message,
      { cause: error },
    );
  }
  return new BulkDomainError(
    'PERSISTENCE_FAILURE',
    'No se pudo completar la operación.',
    { cause: error },
  );
}
