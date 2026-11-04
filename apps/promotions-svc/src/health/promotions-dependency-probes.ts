import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promotionsBrokerBinding } from '../coupons/event-contract.generated.js';
import type { PromotionsConfigService } from '../infrastructure/config/promotions-config.js';
import type { PromotionsDependencyProbes } from './promotions-readiness.service.js';

interface DatabaseClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): void;
}
interface ProbeChannel {
  checkQueue(queue: string): Promise<unknown>;
  close(): Promise<void>;
  on(event: 'error', listener: () => void): void;
}
interface ProbeConnection {
  createChannel(): Promise<ProbeChannel>;
  close(): Promise<void>;
  on(event: 'error', listener: () => void): void;
}

// Every check owns its connections. Never creates topology, consumes or publishes.
export function nativePromotionsDependencyProbes(
  config: PromotionsConfigService,
): PromotionsDependencyProbes {
  if (!config.settings.dependencyProbesEnabled)
    return Object.freeze({ database: 'disabled', broker: 'disabled' });
  const require = createRequire(import.meta.url);
  return {
    database: {
      async check(signal) {
        signal.throwIfAborted();
        const pg: unknown = require('pg');
        if (
          typeof pg !== 'object' ||
          pg === null ||
          !('Client' in pg) ||
          typeof pg.Client !== 'function'
        )
          throw new Error('DATABASE_PROBE_DRIVER_UNAVAILABLE');
        const Client = pg.Client as new (
          options: Record<string, unknown>,
        ) => DatabaseClient;
        const database = config.settings.database;
        const client = new Client({
          host: database.host,
          port: database.port,
          database: database.database,
          user: database.user,
          password: database.password,
          ssl: {
            rejectUnauthorized: true,
            ca: readFileSync(database.sslRootCert, 'utf8'),
          },
          connectionTimeoutMillis: 750,
          query_timeout: 750,
          statement_timeout: 750,
        });
        client.on('error', () => undefined);
        let closing: Promise<void> | undefined;
        const close = () => (closing ??= client.end().catch(() => undefined));
        const abort = () => {
          void close();
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          await client.connect();
          signal.throwIfAborted();
          await client.query('SELECT 1');
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener('abort', abort);
          await close();
        }
      },
    },
    broker: {
      async check(signal) {
        signal.throwIfAborted();
        const amqp: unknown = require('amqplib');
        if (
          typeof amqp !== 'object' ||
          amqp === null ||
          !('connect' in amqp) ||
          typeof amqp.connect !== 'function'
        )
          throw new Error('BROKER_PROBE_DRIVER_UNAVAILABLE');
        const connect = amqp.connect as (
          url: string,
          options: Record<string, unknown>,
        ) => Promise<ProbeConnection>;
        let connection: ProbeConnection | undefined;
        let channel: ProbeChannel | undefined;
        let closing: Promise<void> | undefined;
        const close = () => {
          if (!connection) return Promise.resolve();
          return (closing ??= connection.close().catch(() => undefined));
        };
        const abort = () => {
          void close();
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          connection = await connect(config.settings.rabbitmqUrl, {
            timeout: 750,
          });
          connection.on('error', () => undefined);
          signal.throwIfAborted();
          channel = await connection.createChannel();
          channel.on('error', () => undefined);
          signal.throwIfAborted();
          await channel.checkQueue(promotionsBrokerBinding.queue);
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener('abort', abort);
          await channel?.close().catch(() => undefined);
          await close();
        }
      },
    },
  };
}
