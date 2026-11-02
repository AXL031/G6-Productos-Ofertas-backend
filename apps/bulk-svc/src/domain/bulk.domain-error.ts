export type BulkDomainErrorCode =
  | 'INVALID_INPUT'
  | 'ARCHIVO_INVALIDO'
  | 'ARCHIVO_EXCEDE_LIMITE'
  | 'PLANTILLA_INCOMPATIBLE'
  | 'CONTENIDO_ACTIVO_NO_PERMITIDO'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'DEPENDENCY_PENDING'
  | 'PARTIAL_RESULT'
  | 'BATCH_NOT_FOUND'
  | 'STORAGE_UNAVAILABLE'
  | 'PERSISTENCE_FAILURE';

export class BulkDomainError extends Error {
  constructor(
    readonly code: BulkDomainErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BulkDomainError';
  }
}
