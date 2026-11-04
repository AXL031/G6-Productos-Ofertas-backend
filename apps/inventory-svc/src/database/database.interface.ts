import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../drizzle/schema.js';

export type DrizzleDatabase = NodePgDatabase<typeof schema>;

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  drizzle?: DrizzleDatabase | null;
}

export interface IDatabaseService {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (client: IDatabaseClient) => Promise<T>): Promise<T>;
  getDrizzle?(): DrizzleDatabase | null;
  isHealthy(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }>;
}
