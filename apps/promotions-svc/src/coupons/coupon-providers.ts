import type { Provider } from '@nestjs/common';
import { h4EventAdapters } from './h4-event-adapters.js';
import { assignedH4Contracts } from './assigned-h4-contract.generated.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Pool as PgPool, PoolConfig } from 'pg';
import { PromotionsPersistence } from '../infrastructure/persistence/promotions-persistence.js';
import { PromotionsConfigService } from '../infrastructure/config/promotions-config.js';
import {
  CouponAmqpPublisher,
  CouponCommandDeliveryHandler,
  type ConfirmChannelPort,
} from './coupon-amqp.js';
import {
  CouponOutbox,
  type ConfirmedResultPublisher,
} from './coupon-outbox.js';
import {
  CouponCommandProcessor,
  type CouponEvidenceProvider,
} from './coupon-transactions.js';
import { record } from './schema-validator.js';
import type { ConsumerChannelPort } from './coupon-consumer.js';
import { CouponOutboxPump } from './coupon-outbox-pump.js';
import {
  COUPON_RUNTIME_BOUNDARY,
  CouponRuntime,
  type CouponRuntimeBoundary,
} from './coupon-runtime.js';
import { PromotionsStartupLogger } from '../infrastructure/logging/startup-logger.js';
import {
  ASSIGNED_EVENT_ADAPTERS,
  PROMOTIONS_BROKER_IDENTITY,
  PromotionsAssignedEventDispatcher,
  blockedBrokerIdentity,
  type AssignedEventAdapters,
  type PromotionsBrokerIdentity,
} from './assigned-event-dispatcher.js';

export const COUPON_RESOURCES = Symbol('COUPON_RESOURCES');
export const COUPON_EVIDENCE_PROVIDER = Symbol('COUPON_EVIDENCE_PROVIDER');
interface BrokerConnection {
  createConfirmChannel(): Promise<ConfirmChannelPort>;
  createChannel(): Promise<
    ConsumerChannelPort & {
      on(event: string, listener: () => void): void;
    }
  >;
  close(): Promise<void>;
  on(event: string, listener: () => void): void;
}
interface CouponResources {
  pool: PgPool;
  publisher: ConfirmedResultPublisher;
  openConsumerChannel(): Promise<ConsumerChannelPort>;
  onApplicationShutdown(): Promise<void>;
}

// Driver entry points are checked at this JS boundary; all use remains typed by ports.
export function nativeCouponResources(
  config: PromotionsConfigService,
): CouponResources {
  const require = createRequire(import.meta.url);
  const pg: unknown = require('pg');
  const amqp: unknown = require('amqplib');
  if (
    !record(pg) ||
    typeof pg.Pool !== 'function' ||
    !record(amqp) ||
    typeof amqp.connect !== 'function'
  ) {
    throw new Error('COUPON_DRIVER_UNAVAILABLE');
  }
  const Pool = pg.Pool as new (options: PoolConfig) => PgPool;
  const connect = amqp.connect as (
    url: string,
    options: Record<string, unknown>,
  ) => Promise<BrokerConnection>;
  const database = config.settings.database;
  const pool = new Pool({
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(database.sslRootCert, 'utf8'),
    },
    max: 3,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    query_timeout: 5000,
  });
  pool.on('error', () => undefined);
  let opening:
    | Promise<{ connection: BrokerConnection; channel: ConfirmChannelPort }>
    | undefined;
  let closed = false;
  const consumers = new Set<BrokerConnection>();
  async function transport() {
    if (closed) throw new Error('COUPON_TRANSPORT_CLOSED');
    if (!opening) {
      const pending = (async () => {
        const connection = await connect(config.settings.rabbitmqUrl, {
          timeout: 3000,
        });
        connection.on('error', () => undefined);
        connection.on('close', () => {
          if (opening === pending) opening = undefined;
        });
        try {
          const channel = await connection.createConfirmChannel();
          channel.on('error', () => undefined);
          channel.on('close', () => {
            if (opening === pending) opening = undefined;
            void connection.close().catch(() => undefined);
          });
          if (closed) {
            await connection.close();
            throw new Error('COUPON_TRANSPORT_CLOSED');
          }
          return { connection, channel };
        } catch {
          await connection.close().catch(() => undefined);
          throw new Error('COUPON_TRANSPORT_UNAVAILABLE');
        }
      })();
      opening = pending;
      void pending.catch(() => {
        if (opening === pending) opening = undefined;
      });
    }
    return opening;
  }
  return {
    pool,
    openConsumerChannel: async () => {
      if (closed) throw new Error('COUPON_TRANSPORT_CLOSED');
      const connection = await connect(config.settings.rabbitmqUrl, {
        timeout: 3000,
      });
      connection.on('error', () => undefined);
      connection.on('close', () => consumers.delete(connection));
      consumers.add(connection);
      try {
        if (closed) throw new Error('COUPON_TRANSPORT_CLOSED');
        const channel = await connection.createChannel();
        channel.on('error', () => undefined);
        channel.on('close', () => {
          void connection.close().catch(() => undefined);
        });
        return channel;
      } catch {
        await connection.close().catch(() => undefined);
        throw new Error('COUPON_CONSUMER_TRANSPORT_UNAVAILABLE');
      }
    },
    publisher: {
      publishConfirmed: async (result) => {
        try {
          await new CouponAmqpPublisher(
            (await transport()).channel,
          ).publishConfirmed(result);
        } catch {
          throw new Error('PUBLISH_NOT_CONFIRMED');
        }
      },
    },
    // Runtime drains its consumer/pump in onModuleDestroy before resources close.
    onApplicationShutdown: async () => {
      closed = true;
      const pending = opening;
      opening = undefined;
      const active = await pending?.catch(() => undefined);
      await active?.connection.close().catch(() => undefined);
      await Promise.allSettled(
        [...consumers].map((connection) => connection.close()),
      );
      await pool.end();
    },
  };
}

export const couponProviders: Provider[] = [
  { provide: ASSIGNED_EVENT_ADAPTERS, useValue: h4EventAdapters },
  { provide: PROMOTIONS_BROKER_IDENTITY, useValue: blockedBrokerIdentity },
  {
    provide: PromotionsAssignedEventDispatcher,
    inject: [COUPON_RESOURCES, ASSIGNED_EVENT_ADAPTERS],
    useFactory: (resources: CouponResources, adapters: AssignedEventAdapters) =>
      new PromotionsAssignedEventDispatcher(
        resources.pool,
        adapters,
        assignedH4Contracts,
        true,
      ),
  },
  {
    provide: PromotionsPersistence,
    inject: [COUPON_RESOURCES],
    useFactory: (resources: CouponResources) =>
      new PromotionsPersistence(resources.pool),
  },
  {
    provide: COUPON_RUNTIME_BOUNDARY,
    inject: [PromotionsAssignedEventDispatcher, PROMOTIONS_BROKER_IDENTITY],
    useFactory: (
      dispatcher: PromotionsAssignedEventDispatcher,
      identity: PromotionsBrokerIdentity,
    ): CouponRuntimeBoundary => ({
      assertReady: async () => {
        try {
          dispatcher.assertReady();
          await identity.assertReady();
        } catch {
          throw new Error(
            'COUPON_RUNTIME_BLOCKED_EVIDENCE_ELIGIBILITY_DISPATCHER_IDENTITY',
          );
        }
        throw new Error(
          'COUPON_RUNTIME_BLOCKED_EVIDENCE_ELIGIBILITY_DISPATCHER_IDENTITY',
        );
      },
      authenticatedActor: (delivery) => identity.actor(delivery),
      handleOtherAssignedEvent: async (delivery) => {
        await dispatcher.process(delivery, await identity.actor(delivery));
      },
      failed: () => new PromotionsStartupLogger().runtimeStopped(),
    }),
  },
  {
    provide: COUPON_RESOURCES,
    inject: [PromotionsConfigService],
    useFactory: nativeCouponResources,
  },
  {
    provide: COUPON_EVIDENCE_PROVIDER,
    useValue: {
      verify: async () => {
        throw new Error('COUPON_EVIDENCE_UNAVAILABLE');
      },
    } satisfies CouponEvidenceProvider,
  },
  {
    provide: CouponCommandProcessor,
    inject: [COUPON_RESOURCES, COUPON_EVIDENCE_PROVIDER],
    useFactory: (
      resources: CouponResources,
      evidence: CouponEvidenceProvider,
    ) => new CouponCommandProcessor(resources.pool, evidence),
  },
  {
    provide: CouponOutbox,
    inject: [COUPON_RESOURCES],
    useFactory: (resources: CouponResources) =>
      new CouponOutbox(resources.pool, resources.publisher),
  },
  {
    provide: CouponCommandDeliveryHandler,
    inject: [CouponCommandProcessor],
    useFactory: (processor: CouponCommandProcessor) =>
      new CouponCommandDeliveryHandler(processor),
  },
  {
    provide: CouponRuntime,
    inject: [
      PromotionsConfigService,
      COUPON_RUNTIME_BOUNDARY,
      COUPON_RESOURCES,
      CouponCommandDeliveryHandler,
      CouponOutbox,
    ],
    useFactory: (
      config: PromotionsConfigService,
      boundary: CouponRuntimeBoundary,
      resources: CouponResources,
      handler: CouponCommandDeliveryHandler,
      outbox: CouponOutbox,
    ) =>
      new CouponRuntime(
        config.settings.couponRuntimeEnabled,
        boundary,
        () => resources.openConsumerChannel(),
        handler,
        new CouponOutboxPump(outbox, () =>
          new PromotionsStartupLogger().outboxPending(),
        ),
      ),
  },
];
