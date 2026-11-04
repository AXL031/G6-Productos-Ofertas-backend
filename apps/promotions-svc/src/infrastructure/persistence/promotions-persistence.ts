import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import * as schema from './schema.js';
import { PromotionsRepositories } from './repositories.js';
import { inPromotionsTransaction } from './sql-transaction.js';
import { PromotionRuleError } from '../../domain/promotion-rules.js';
import { CommercialDependencyError } from '../../domain/commercial-context.js';

// Do not expose driver messages, query parameters, credentials, or raw causes.
export class PromotionsPersistenceError extends Error {
  constructor(readonly sqlState?: string) {
    super('PROMOTIONS_PERSISTENCE_FAILED');
    this.name = 'PromotionsPersistenceError';
  }
}

function sqlState(error: unknown): string | undefined {
  for (
    let depth = 0;
    depth < 8 && error && typeof error === 'object';
    depth++
  ) {
    if (
      'code' in error &&
      typeof error.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(error.code)
    )
      return error.code;
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}

export class PromotionsPersistence {
  // Constructing this provider does not connect, migrate, or register consumers.
  // Resource shutdown remains owned by COUPON_RESOURCES.
  constructor(private readonly pool: Pool) {}

  transaction<T>(
    work: (repositories: PromotionsRepositories) => Promise<T>,
  ): Promise<T> {
    return this.run(work, false);
  }

  read<T>(
    work: (repositories: PromotionsRepositories) => Promise<T>,
  ): Promise<T> {
    return this.run(work, true);
  }

  private async run<T>(
    work: (repositories: PromotionsRepositories) => Promise<T>,
    readOnly: boolean,
  ): Promise<T> {
    try {
      return await inPromotionsTransaction<T, PoolClient>(
        this.pool,
        (client) =>
          work(
            new PromotionsRepositories(
              drizzle(client, { schema, logger: false }),
            ),
          ),
        readOnly,
      );
    } catch (error) {
      if (
        error instanceof PromotionRuleError ||
        error instanceof CommercialDependencyError
      )
        throw error;
      throw new PromotionsPersistenceError(sqlState(error));
    }
  }
}
