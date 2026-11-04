import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { BULK_READINESS_POOL } from '../config/bulk-environment.js';
import { bulkSchema } from './bulk.schema.js';

export const BULK_DATABASE = Symbol('BULK_DATABASE');
export type BulkDatabase = NodePgDatabase<typeof bulkSchema>;

/** Builds Drizzle only over the real readiness pool; test doubles remain untouched. */
export function createBulkDatabase(pool: unknown): BulkDatabase | null {
  if (!(pool instanceof Pool)) return null;
  return drizzle(pool, { schema: bulkSchema, logger: false });
}

export const bulkDatabaseProvider = {
  provide: BULK_DATABASE,
  inject: [BULK_READINESS_POOL],
  useFactory: createBulkDatabase,
};
