import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PRICE_AUDIT_CONFIG, type AuditConfig } from '../config/environment.js';
import { auditSchema } from './audit.schema.js';

export type AuditDb = NodePgDatabase<typeof auditSchema>;
export type AuditTransaction = Parameters<
  Parameters<AuditDb['transaction']>[0]
>[0];

@Injectable()
export class AuditDatabase implements OnApplicationShutdown {
  readonly db: AuditDb;
  private readonly pool: Pool;
  private readonly logger = new Logger(AuditDatabase.name);

  constructor(@Inject(PRICE_AUDIT_CONFIG) config: AuditConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl,
      max: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=pg_catalog,price_audit',
    });
    this.pool.on('error', () =>
      this.logger.warn('Conexión PostgreSQL inactiva no disponible.'),
    );
    this.db = drizzle(this.pool, { schema: auditSchema, logger: false });
  }

  async check(): Promise<boolean> {
    try {
      await this.pool.query(
        'SELECT target_type FROM price_audit.price_audit_log, price_audit.inbox, price_audit.export_jobs LIMIT 0',
      );
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
