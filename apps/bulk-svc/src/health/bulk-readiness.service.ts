import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';
import { isIP } from 'node:net';
import {
  BULK_ENVIRONMENT,
  BULK_READINESS_POOL,
  type BulkEnvironment,
} from '../config/bulk-environment.js';
import { BULK_AMQP_URL } from '../messaging/bulk-rabbitmq.js';
import { BulkOutboxRelay } from '../messaging/bulk-outbox-relay.js';
import { CatalogBulkResultConsumer } from '../messaging/catalog-bulk-result-consumer.js';

export interface BulkReadinessPool {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): this;
}

export type BulkReadinessReason =
  | 'READY'
  | 'AUTHORIZED_DEMO'
  | 'DATABASE_NOT_CONFIGURED'
  | 'DATABASE_UNAVAILABLE'
  | 'AMQP_NOT_CONFIGURED'
  | 'AMQP_DISABLED'
  | 'AMQP_TEMPORARY_UNAVAILABLE'
  | 'AMQP_TOPOLOGY_BLOCKED';

export interface BulkReadinessResult {
  ready: boolean;
  reason: BulkReadinessReason;
}

export function createBulkReadinessPool(
  config: BulkEnvironment,
): BulkReadinessPool | null {
  if (!config.databaseUrl) return null;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    query_timeout: config.databaseQueryTimeoutMs,
    statement_timeout: config.databaseQueryTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
  });
  const logger = new Logger('BulkReadinessService');
  pool.on('error', () =>
    logger.warn('Conexión PostgreSQL inactiva no disponible.'),
  );
  return pool;
}

@Injectable()
export class BulkReadinessService implements OnModuleDestroy {
  private readonly logger = new Logger(BulkReadinessService.name);

  constructor(
    @Inject(BULK_ENVIRONMENT) private readonly config: BulkEnvironment,
    @Inject(BULK_READINESS_POOL)
    private readonly pool: BulkReadinessPool | null,
    @Optional()
    @Inject(BULK_AMQP_URL)
    private readonly amqpUrl: string | null = null,
    @Optional() private readonly relay?: BulkOutboxRelay,
    @Optional() private readonly resultConsumer?: CatalogBulkResultConsumer,
  ) {}

  async check(): Promise<boolean> {
    return (await this.probe()).ready;
  }

  async probe(remoteAddress?: string): Promise<BulkReadinessResult> {
    if (!this.config.databaseUrl || !this.pool)
      return { ready: false, reason: 'DATABASE_NOT_CONFIGURED' };
    try {
      await this.pool.query('SELECT 1 FROM bulk.batch_jobs LIMIT 0');
    } catch {
      this.logger.warn('La comprobación de PostgreSQL no está disponible.');
      return { ready: false, reason: 'DATABASE_UNAVAILABLE' };
    }

    if (!this.amqpUrl) {
      if (this.isAuthorizedDemoPeer(remoteAddress))
        return { ready: true, reason: 'AUTHORIZED_DEMO' };
      return {
        ready: false,
        reason:
          process.env.BULK_AMQP_ENABLED === 'false'
            ? 'AMQP_DISABLED'
            : 'AMQP_NOT_CONFIGURED',
      };
    }

    if (process.env.BULK_AMQP_ENABLED !== 'true')
      return { ready: false, reason: 'AMQP_NOT_CONFIGURED' };
    const workerStates = [
      this.relay?.getOperationalState(),
      this.resultConsumer?.getOperationalState(),
    ];
    if (workerStates.includes('TOPOLOGY_BLOCKED'))
      return { ready: false, reason: 'AMQP_TOPOLOGY_BLOCKED' };
    if (workerStates.some((state) => state !== 'READY'))
      return { ready: false, reason: 'AMQP_TEMPORARY_UNAVAILABLE' };
    return { ready: true, reason: 'READY' };
  }

  private isAuthorizedDemoPeer(remoteAddress?: string): boolean {
    const peer = remoteAddress?.replace(/^::ffff:/, '');
    if (
      process.env.GATEWAY_DEMO_NO_AUTH_ENABLED !== 'true' ||
      !peer ||
      isIP(peer) === 0
    )
      return false;
    const allowlist = (process.env.BULK_DEMO_GATEWAY_IPS ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    return allowlist.includes(peer);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}
