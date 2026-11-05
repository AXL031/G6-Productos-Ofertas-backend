import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import { and, eq, sql } from 'drizzle-orm';
import { PricingRepository } from '../persistence/pricing.repository.js';
import { inbox } from '../persistence/pricing.schema.js';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { CatalogSkuDeactivated } from './catalog-sku-deactivated.js';
import { PricingProductInitialization } from './pricing-initialization.js';

const QUEUE = 'po.precios.q';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

@Injectable()
export class PricingInboxConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  available = false;
  private stopped = false;
  private paused = false;
  private connection?: ChannelModel;
  private channel?: Channel;
  private consumerTag?: string;
  private starting?: Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private url?: string;
  private readonly logger = new Logger(PricingInboxConsumer.name);

  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    private readonly initialization: PricingProductInitialization,
    private readonly deactivation: CatalogSkuDeactivated,
    private readonly repository: PricingRepository,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.amqpUrl) {
      this.url = this.config.amqpUrl;
      void this.start(this.url);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    await this.starting?.catch(() => undefined);
    try {
      if (this.consumerTag && this.channel)
        await this.channel.cancel(this.consumerTag);
    } catch {
      // Closing the channel requeues any delivery that was not ACKed.
    }
    await Promise.allSettled(this.inFlight);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.available = false;
  }

  private start(url: string): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.open(url).finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    return starting;
  }

  private async open(url: string): Promise<void> {
    let connection: ChannelModel | undefined;
    let channel: Channel | undefined;
    try {
      connection = await connect(url, { timeout: 2500 });
      this.connection = connection;
      connection.on('error', () => {
        if (this.connection === connection) this.available = false;
      });
      connection.on('close', () => {
        if (this.connection === connection) {
          this.connection = undefined;
          this.channel = undefined;
          this.consumerTag = undefined;
          this.available = false;
          this.scheduleReconnect();
        }
      });
      channel = await connection.createChannel();
      this.channel = channel;
      channel.on('error', () => {
        if (this.channel === channel) this.available = false;
      });
      channel.on('close', () => {
        if (this.channel === channel) {
          this.channel = undefined;
          this.consumerTag = undefined;
          this.available = false;
          if (this.connection === connection) {
            this.connection = undefined;
            void connection?.close().catch(() => undefined);
          }
          this.scheduleReconnect();
        }
      });
      await channel.checkExchange('po.comandos.x');
      await channel.checkExchange('po.eventos.x');
      await channel.checkQueue(QUEUE);
      await channel.prefetch(20);
      const subscription = await channel.consume(
        QUEUE,
        (message) => {
          if (message) this.track(this.process(channel!, message));
        },
        { noAck: false },
      );
      this.consumerTag = subscription.consumerTag;
      this.available = true;
    } catch {
      this.available = false;
      if (this.channel === channel) this.channel = undefined;
      if (this.connection === connection) this.connection = undefined;
      await channel?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
      if (!this.stopped)
        this.logger.error(
          'Consumidor AMQP de Pricing no disponible; adquisición pausada.',
        );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.paused || !this.url || this.reconnectTimer) return;
    this.available = false;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start(this.url!);
    }, 3000);
    this.reconnectTimer.unref();
  }

  private track(operation: Promise<void>): void {
    this.inFlight.add(operation);
    void operation
      .catch(() => {
        void this.pause('PROCESSING_UNHANDLED');
      })
      .finally(() => this.inFlight.delete(operation));
  }

  private async process(
    owner: Channel,
    message: ConsumeMessage,
  ): Promise<void> {
    if (this.paused || this.stopped) return;
    if (message.content.length > MAX_MESSAGE_BYTES) {
      await this.pause('MESSAGE_TOO_LARGE');
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const parsed: unknown = JSON.parse(message.content.toString('utf8'));
        const name =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).name
            : undefined;
        if (name === 'pricing.product.initialization.requested') {
          await this.initialization.consume(message.content);
        } else if (name === 'catalog.sku.deactivated') {
          await this.deactivation.consume(message.content);
        } else if (name === 'pricing.bulk.price.apply.requested') {
          await this.recordBulkBlocked(parsed);
        } else {
          throw new Error('PRICING_UNSUPPORTED_MESSAGE');
        }
        try {
          owner.ack(message);
        } catch {
          /* Broker requeues after channel loss; Inbox makes replay safe. */
        }
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'PRICING_INVALID_MESSAGE_ENVELOPE'
        ) {
          try {
            const value: unknown = JSON.parse(message.content.toString('utf8'));
            if (await this.recordInvalidEnvelope(value)) {
              try {
                owner.ack(message);
              } catch {
                /* Broker requeues after channel loss. */
              }
              return;
            }
          } catch {
            // A durable-storage failure remains retryable; unidentifiable
            // corruption is paused below with its delivery left unacked.
          }
        }
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * (attempt + 1)),
          );
        else {
          const rawCode = error instanceof Error ? error.message : '';
          const code = /^[A-Z0-9_]{1,64}$/.test(rawCode)
            ? rawCode
            : 'PROCESSING_FAILED';
          await this.pause(code);
        }
      }
    }
  }

  private async recordInvalidEnvelope(value: unknown): Promise<boolean> {
    if (
      !isObject(value) ||
      !UUID.test(String(value.message_id)) ||
      !UUID.test(String(value.correlation_id))
    )
      return false;
    const handlers: Record<string, string> = {
      'pricing.product.initialization.requested':
        'pricing.product.initialization.v1',
      'catalog.sku.deactivated': 'pricing.catalog-sku-deactivated.v1',
      'pricing.bulk.price.apply.requested': 'pricing.bulk.price.apply.v1',
    };
    const name = typeof value.name === 'string' ? value.name : '';
    const handler = handlers[name];
    if (!handler) return false;
    await this.repository.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, value.message_id as string),
            eq(inbox.handler, handler),
          ),
        )
        .limit(1);
      if (existing) {
        if (canonical(existing.payload) !== canonical(value))
          throw new Error('PRICING_MESSAGE_ID_CONFLICT');
        return;
      }
      await tx
        .insert(inbox)
        .values({
          messageId: value.message_id as string,
          handler,
          eventName: name,
          correlationId: value.correlation_id as string,
          payload: value,
          result: 'REJECTED_INVALID_ENVELOPE',
        })
        .onConflictDoNothing();
    });
    return true;
  }

  private async recordBulkBlocked(value: unknown): Promise<void> {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('message_id' in value) ||
      typeof value.message_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.message_id,
      ) ||
      !('correlation_id' in value) ||
      typeof value.correlation_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.correlation_id,
      ) ||
      !('data' in value) ||
      !isObject(value.data) ||
      !('schema_version' in value) ||
      value.schema_version !== 1 ||
      !('occurred_at' in value) ||
      typeof value.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(value.occurred_at)) ||
      !('operation_id' in value) ||
      typeof value.operation_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.operation_id,
      ) ||
      !('producer' in value) ||
      value.producer !== 'bulk-svc' ||
      !('kind' in value) ||
      value.kind !== 'command' ||
      !('name' in value) ||
      value.name !== 'pricing.bulk.price.apply.requested'
    )
      throw new Error('PRICING_INVALID_BULK_ENVELOPE');
    const message = value as Record<string, unknown>;
    await this.repository.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${message.operation_id as string}, 0))`,
      );
      const [sameMessage] = await tx
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, message.message_id as string),
            eq(inbox.handler, 'pricing.bulk.price.apply.v1'),
          ),
        )
        .limit(1);
      if (sameMessage) {
        if (canonical(sameMessage.payload) !== canonical(message))
          throw new Error('PRICING_MESSAGE_ID_CONFLICT');
        return;
      }
      const priorOperations = await tx
        .select({ payload: inbox.payload })
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, 'pricing.bulk.price.apply.v1'),
            sql`${inbox.payload}->>'operation_id' = ${message.operation_id as string}`,
          ),
        );
      const sameIntent = priorOperations.some((row) => {
        const prior = isObject(row.payload) ? row.payload : {};
        return canonical(prior.data) === canonical(message.data);
      });
      await tx
        .insert(inbox)
        .values({
          messageId: message.message_id as string,
          handler: 'pricing.bulk.price.apply.v1',
          eventName: 'pricing.bulk.price.apply.requested',
          correlationId: message.correlation_id as string,
          payload: message,
          result: priorOperations.length
            ? sameIntent
              ? 'BLOCKED_CONTRACT_DUPLICATE'
              : 'BLOCKED_CONTRACT_OPERATION_ID_CONFLICT'
            : 'BLOCKED_CONTRACT',
        })
        .onConflictDoNothing();
    });
  }

  private async pause(reason: string): Promise<void> {
    this.paused = true;
    this.available = false;
    try {
      if (this.consumerTag && this.channel)
        await this.channel.cancel(this.consumerTag);
    } catch {
      // Keep the current message unacknowledged; shutdown will return it.
    }
    this.logger.error(`Consumidor AMQP de Pricing pausado (${reason}).`);
  }
}
