import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { pricingSchema } from './pricing.schema.js';

export type PricingDb = NodePgDatabase<typeof pricingSchema>;
export type PricingTransaction = Parameters<
  Parameters<PricingDb['transaction']>[0]
>[0];

@Injectable()
export class PricingDatabase implements OnApplicationShutdown {
  readonly db: PricingDb;
  private readonly pool: Pool;
  private readonly logger = new Logger(PricingDatabase.name);

  constructor(@Inject(PRICING_CONFIG) config: PricingConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl,
      max: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=pg_catalog,pricing',
    });
    this.pool.on('error', () =>
      this.logger.warn('Conexión PostgreSQL inactiva no disponible.'),
    );
    this.db = drizzle(this.pool, { schema: pricingSchema, logger: false });
  }

  async check(): Promise<boolean> {
    try {
      await this.pool.query(
        'SELECT 1 FROM pricing.prices, pricing.price_validities, pricing.scheduled_prices, pricing.bulk_price_jobs, pricing.bulk_price_rows, pricing.outbox LIMIT 0',
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
