import { Injectable } from '@nestjs/common';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { Database, type CatalogTransaction } from './database.js';

/** Reusable transaction boundary for one local Catalog aggregate operation. */
@Injectable()
export class CatalogTransactionManager {
  constructor(private readonly database: Database) {}

  run<T>(
    operation: (tx: CatalogTransaction) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    return this.database.transaction(operation, config);
  }
}
