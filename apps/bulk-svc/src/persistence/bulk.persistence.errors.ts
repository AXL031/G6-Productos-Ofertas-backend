export type BulkPersistenceErrorCode =
  | 'UNIQUE_CONFLICT'
  | 'FOREIGN_KEY_VIOLATION'
  | 'CHECK_VIOLATION'
  | 'NOT_NULL_VIOLATION'
  | 'CONNECTION_FAILURE'
  | 'TIMEOUT'
  | 'NOT_CONFIGURED'
  | 'PERSISTENCE_FAILURE';

export class BulkPersistenceError extends Error {
  constructor(
    readonly code: BulkPersistenceErrorCode,
    cause?: unknown,
  ) {
    super(publicMessage(code), { cause });
    this.name = 'BulkPersistenceError';
  }
}

function publicMessage(code: BulkPersistenceErrorCode): string {
  switch (code) {
    case 'UNIQUE_CONFLICT':
      return 'La operación ya existe con esa identidad.';
    case 'FOREIGN_KEY_VIOLATION':
      return 'La referencia de persistencia no existe.';
    case 'CHECK_VIOLATION':
      return 'Los datos no cumplen las reglas de persistencia.';
    case 'NOT_NULL_VIOLATION':
      return 'Falta un dato obligatorio de persistencia.';
    case 'CONNECTION_FAILURE':
      return 'La persistencia no está disponible.';
    case 'TIMEOUT':
      return 'La operación de persistencia excedió el tiempo permitido.';
    case 'NOT_CONFIGURED':
      return 'La persistencia de Bulk no está configurada.';
    case 'PERSISTENCE_FAILURE':
      return 'No se pudo completar la operación de persistencia.';
  }
}

export function persistenceError(error: unknown): BulkPersistenceError {
  if (error instanceof BulkPersistenceError) return error;
  const pgError = findPgError(error);
  const code: BulkPersistenceErrorCode =
    pgError?.code === '23505'
      ? 'UNIQUE_CONFLICT'
      : pgError?.code === '23503'
        ? 'FOREIGN_KEY_VIOLATION'
        : pgError?.code === '23514'
          ? 'CHECK_VIOLATION'
          : pgError?.code === '23502'
            ? 'NOT_NULL_VIOLATION'
            : pgError?.code === '57014' || pgError?.code === 'ETIMEDOUT'
              ? 'TIMEOUT'
              : pgError?.code?.startsWith('08') ||
                  pgError?.code === 'ECONNREFUSED' ||
                  pgError?.code === 'ECONNRESET'
                ? 'CONNECTION_FAILURE'
                : 'PERSISTENCE_FAILURE';
  return new BulkPersistenceError(code, error);
}

function findPgError(error: unknown): { code?: string } | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || visited.has(current))
      continue;
    visited.add(current);
    if ('code' in current && typeof current.code === 'string')
      return { code: current.code };
    for (const key of ['cause', 'originalError', 'parent']) {
      if (key in current) pending.push(Reflect.get(current, key));
    }
  }
  return undefined;
}
