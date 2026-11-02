export type CatalogPersistenceFailure =
  | 'connection'
  | 'unique'
  | 'foreign_key'
  | 'not_null'
  | 'check'
  | 'serialization'
  | 'deadlock'
  | 'deferred_constraint'
  | 'other';

type PostgresFailure = Error & {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
};

export class CatalogPersistenceError extends Error {
  readonly failure: CatalogPersistenceFailure;
  readonly sqlState?: string;
  readonly constraintName?: string;

  constructor(
    failure: CatalogPersistenceFailure,
    sqlState?: string,
    constraintName?: string,
  ) {
    super('Falló una operación de persistencia de Catálogo');
    this.name = 'CatalogPersistenceError';
    this.failure = failure;
    this.sqlState = sqlState;
    this.constraintName = constraintName;
  }
}

function isPostgresFailure(value: unknown): value is PostgresFailure {
  return value instanceof Error && 'code' in value;
}

function isDatabaseCode(code: string): boolean {
  return (
    /^[0-9A-Z]{5}$/.test(code) ||
    code.startsWith('ECONN') ||
    code.startsWith('EHOST') ||
    code.startsWith('ENOTFOUND') ||
    code.startsWith('ETIMEDOUT') ||
    code.startsWith('ERR_TLS_')
  );
}

function findPostgresFailure(value: unknown): PostgresFailure | undefined {
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      isPostgresFailure(current) &&
      typeof current.code === 'string' &&
      isDatabaseCode(current.code)
    )
      return current;
    current = current.cause;
  }
  return undefined;
}

export function translatePostgresFailure(
  value: unknown,
  commitPhase = false,
): CatalogPersistenceError | undefined {
  if (value instanceof CatalogPersistenceError) return value;
  const postgresFailure = findPostgresFailure(value);
  if (!postgresFailure) {
    // pg/pg-pool emit these exact timeout/disconnect errors without SQLSTATE.
    // Do not classify arbitrary domain exceptions by a broad text match.
    const seen = new Set<unknown>();
    let current = value;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      if (
        current.name === 'Error' &&
        [
          'Query read timeout',
          'timeout exceeded when trying to connect',
          'Connection terminated due to connection timeout',
          'Connection terminated unexpectedly',
          'Connection terminated',
        ].includes(current.message)
      )
        return new CatalogPersistenceError('connection');
      current = current.cause;
    }
    return undefined;
  }
  const code = postgresFailure.code;
  const driverCode = typeof code === 'string' ? code : undefined;
  const sqlState =
    driverCode && /^[0-9A-Z]{5}$/.test(driverCode) ? driverCode : undefined;
  const constraint = postgresFailure.constraint;
  const constraintName =
    typeof constraint === 'string' ? constraint : undefined;

  let failure: CatalogPersistenceFailure;
  if (
    driverCode?.startsWith('08') ||
    driverCode?.startsWith('53') ||
    ['57P01', '57P02', '57P03', '57014', '55P03'].includes(driverCode ?? '') ||
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENOTFOUND',
      'ETIMEDOUT',
    ].includes(driverCode ?? '') ||
    driverCode?.startsWith('ERR_TLS_')
  ) {
    failure = 'connection';
  } else if (
    commitPhase &&
    ['23503', '23505', '23514'].includes(sqlState ?? '')
  ) {
    failure = 'deferred_constraint';
  } else {
    switch (driverCode) {
      case '23505':
        failure = 'unique';
        break;
      case '23503':
        failure = 'foreign_key';
        break;
      case '23502':
        failure = 'not_null';
        break;
      case '23514':
        failure = 'check';
        break;
      case '40001':
        failure = 'serialization';
        break;
      case '40P01':
        failure = 'deadlock';
        break;
      default:
        failure = 'other';
    }
  }

  return new CatalogPersistenceError(failure, sqlState, constraintName);
}
