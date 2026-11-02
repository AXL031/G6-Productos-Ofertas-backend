import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import amqp, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import { BulkDomainError } from '../domain/bulk.domain-error.js';
import { BulkPersistenceRepository } from '../persistence/bulk.repository.js';
import { BULK_AMQP_URL } from './bulk-rabbitmq.js';

const QUEUE = 'po.masivos.q';
const RESULT_ROUTES = new Set([
  'catalog.bulk.upsert.completed',
  'catalog.bulk.upsert.rejected',
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Envelope = {
  message_id: string;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id: string;
  operation_id: string;
  producer: 'catalog-svc';
  kind: 'result';
  name: string;
  data: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEnvelope(value: unknown, message: ConsumeMessage): Envelope {
  if (!record(value)) throw new Error('INVALID_ENVELOPE');
  const required = [
    'message_id',
    'schema_version',
    'occurred_at',
    'correlation_id',
    'causation_id',
    'operation_id',
    'producer',
    'kind',
    'name',
    'data',
  ];
  if (
    Object.keys(value).length !== required.length ||
    required.some((key) => !(key in value))
  )
    throw new Error('INVALID_ENVELOPE');
  if (
    typeof value.message_id !== 'string' ||
    value.message_id.length === 0 ||
    value.message_id !== message.properties.messageId ||
    value.schema_version !== 1 ||
    typeof value.occurred_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value.occurred_at,
    ) ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    typeof value.correlation_id !== 'string' ||
    !value.correlation_id ||
    typeof value.causation_id !== 'string' ||
    !value.causation_id ||
    typeof value.operation_id !== 'string' ||
    !uuid.test(value.operation_id) ||
    value.producer !== 'catalog-svc' ||
    value.kind !== 'result' ||
    typeof value.name !== 'string' ||
    !RESULT_ROUTES.has(value.name) ||
    message.fields.routingKey !== value.name ||
    message.properties.type !== value.name ||
    message.properties.contentType !== 'application/json' ||
    !record(value.data)
  )
    throw new Error('INVALID_ENVELOPE');
  const data = value.data;
  if (
    !uuid.test(String(data.batch_id)) ||
    !uuid.test(String(data.batch_operation_id))
  )
    throw new Error('INVALID_PAYLOAD');
  if (value.name === 'catalog.bulk.upsert.completed') {
    if (
      Object.keys(data).length !== 3 ||
      !Array.isArray(data.results) ||
      data.results.length === 0
    )
      throw new Error('INVALID_PAYLOAD');
    for (const item of data.results) {
      if (
        !record(item) ||
        Object.keys(item).length !== 6 ||
        !Number.isSafeInteger(item.row_number) ||
        Number(item.row_number) < 2 ||
        typeof item.row_operation_id !== 'string' ||
        !uuid.test(item.row_operation_id) ||
        !(typeof item.product_id === 'string' || item.product_id === null) ||
        typeof item.sku_base !== 'string' ||
        !item.sku_base ||
        !['COMPLETED', 'REJECTED'].includes(String(item.status)) ||
        !(typeof item.code === 'string' || item.code === null) ||
        (item.status === 'COMPLETED' && item.code !== null) ||
        (item.status === 'REJECTED' && typeof item.code !== 'string')
      )
        throw new Error('INVALID_PAYLOAD');
    }
  } else if (
    Object.keys(data).length !== 4 ||
    typeof data.code !== 'string' ||
    !data.code ||
    typeof data.detail !== 'string' ||
    !data.detail
  ) {
    throw new Error('INVALID_PAYLOAD');
  }
  return value as Envelope;
}

@Injectable()
export class CatalogBulkResultConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CatalogBulkResultConsumer.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private stopping = false;
  private paused = false;
  private active: Promise<void> | null = null;
  private processingTail: Promise<void> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: BulkPersistenceRepository,
    @Inject(BULK_AMQP_URL) private readonly amqpUrl: string | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.amqpUrl) return;
    this.reconnectTimer = setInterval(() => {
      if (!this.stopping && !this.paused && !this.channel)
        void this.connectConsumer();
    }, 5000);
    this.reconnectTimer.unref();
    await this.connectConsumer();
  }

  private async connectConsumer(): Promise<void> {
    if (!this.amqpUrl || this.stopping || this.paused || this.channel) return;
    try {
      this.connection = await amqp.connect(this.amqpUrl);
      this.connection.on('error', () => undefined);
      this.connection.on('close', () => {
        this.channel = null;
        this.connection = null;
      });
      this.channel = await this.connection.createChannel();
      await this.channel.prefetch(20);
      const result = await this.channel.consume(
        QUEUE,
        (message) => {
          if (!message || this.stopping || this.paused) return;
          this.processingTail = this.processingTail.then(() =>
            this.handle(message),
          );
          this.active = this.processingTail.finally(() => {
            this.active = null;
          });
        },
        { noAck: false },
      );
      this.consumerTag = result.consumerTag;
    } catch {
      this.logger.warn(
        'Consumidor Catalog no disponible; AMQP Bulk permanece pausado.',
      );
      await this.closeTransport();
    }
  }

  private async handle(message: ConsumeMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    let envelope: Envelope;
    try {
      envelope = validateEnvelope(
        JSON.parse(message.content.toString('utf8')) as unknown,
        message,
      );
    } catch {
      const transportId = message.properties.messageId;
      if (!transportId) return this.pause();
      const digest = createHash('sha256').update(message.content).digest('hex');
      try {
        await this.repository.processInboxOnce(
          {
            messageId: transportId,
            handler: 'bulk.catalog.invalid-result',
            eventName: message.fields.routingKey,
            correlationId: message.properties.correlationId ?? null,
            payload: {
              disposition: 'INVALID_CATALOG_RESULT',
              content_sha256: digest,
            },
          },
          async () => 'DURABLY_REJECTED',
        );
        channel.ack(message);
      } catch {
        this.pause();
      }
      return;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.repository.recordCatalogBulkResult({
          messageId: envelope.message_id,
          operationId: envelope.operation_id,
          causationId: envelope.causation_id,
          eventName: envelope.name as
            'catalog.bulk.upsert.completed' | 'catalog.bulk.upsert.rejected',
          correlationId: envelope.correlation_id,
          payload: envelope as unknown as Record<string, unknown>,
        });
        channel.ack(message);
        return;
      } catch (error) {
        if (error instanceof BulkDomainError) {
          try {
            await this.repository.processInboxOnce(
              {
                messageId: envelope.message_id,
                handler: 'bulk.catalog.invalid-result',
                eventName: envelope.name,
                correlationId: envelope.correlation_id,
                payload: {
                  disposition: 'INVALID_CATALOG_RESULT',
                  error_code: error.code,
                },
              },
              async () => 'DURABLY_REJECTED',
            );
            channel.ack(message);
          } catch {
            this.pause();
          }
          return;
        }
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * (attempt + 1)),
          );
      }
    }
    this.logger.warn(
      'Consumidor Catalog pausado tras fallos técnicos; la entrega queda sin ACK.',
    );
    await this.pause();
  }

  private async pause(): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
      this.consumerTag = null;
    }
  }

  private async closeTransport(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    await this.pause();
    await this.processingTail.catch(() => undefined);
    await this.closeTransport();
  }
}
