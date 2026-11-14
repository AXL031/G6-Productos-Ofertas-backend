import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError } from 'pg';

export class PricingPersistenceError extends Error {
  constructor(
    readonly sqlState?: string,
    readonly clientTimeout = false,
  ) {
    super('Persistencia de Pricing no disponible o restricción rechazada.');
    this.name = 'PricingPersistenceError';
  }
}

export function rethrowPersistenceError(
  error: unknown,
  fromCallback = false,
): never {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  if (cause instanceof DatabaseError) {
    throw new PricingPersistenceError(cause.code);
  }
  if (error instanceof DrizzleQueryError || !fromCallback) {
    throw new PricingPersistenceError(
      undefined,
      cause instanceof Error && cause.message === 'Query read timeout',
    );
  }
  // Los errores del caso de uso conservan su identidad tras el rollback.
  throw error;
}
