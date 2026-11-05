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
      const compatibility = await this.pool.query<{ compatible: boolean }>(`
          SELECT to_regclass('pricing.prices') IS NOT NULL
            AND to_regclass('pricing.price_validities') IS NOT NULL
            AND to_regclass('pricing.scheduled_prices') IS NOT NULL
            AND to_regclass('pricing.bulk_price_jobs') IS NOT NULL
            AND to_regclass('pricing.bulk_price_rows') IS NOT NULL
            AND to_regclass('pricing.outbox') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='pricing' AND table_name='scheduled_prices' AND column_name='product_id')
            AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='pricing' AND table_name='scheduled_prices' AND column_name='correlation_id') AS compatible
      `);
      return compatibility.rows[0]?.compatible === true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
