import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
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
export type CatalogResultConsumerState =
  'NOT_CONFIGURED' | 'CONNECTING' | 'READY' | 'RECOVERING' | 'TOPOLOGY_BLOCKED';
const RESULT_ROUTES = new Set([
  'catalog.bulk.upsert.completed',
  'catalog.bulk.upsert.rejected',
]);
const OTHER_BULK_ROUTES = new Map<
  string,
  { producer: string; kind: 'event' | 'result' }
>([
  [
    'inventory.bulk.stock.adjust.completed',
    { producer: 'inventory-svc', kind: 'result' },
  ],
  [
    'inventory.bulk.stock.adjust.rejected',
    { producer: 'inventory-svc', kind: 'result' },
  ],
  [
    'pricing.bulk.price.apply.completed',
    { producer: 'pricing-svc', kind: 'result' },
  ],
  [
    'pricing.bulk.price.apply.rejected',
    { producer: 'pricing-svc', kind: 'result' },
  ],
  ['inventory.stock.adjusted', { producer: 'inventory-svc', kind: 'event' }],
]);
export const BULK_CONTRACT_RESULT_DISPATCHER = Symbol(
  'BULK_CONTRACT_RESULT_DISPATCHER',
);
export interface BulkContractResultDispatcher {
  dispatch(input: {
    eventName: string;
    messageId: string;
    correlationId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
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

function validateOtherContractEnvelope(
  value: unknown,
  message: ConsumeMessage,
): value is Record<string, unknown> {
  if (!record(value)) return false;
  const route = OTHER_BULK_ROUTES.get(message.fields.routingKey);
  if (!route || !record(value.data)) return false;
  const operationId = value.operation_id;
  const causationId = value.causation_id;
  const exchange = route.kind === 'event' ? 'po.eventos.x' : 'po.resultados.x';
  return (
    typeof value.message_id === 'string' &&
    value.message_id.length > 0 &&
    value.message_id === message.properties.messageId &&
    Number.isInteger(value.schema_version) &&
    Number(value.schema_version) >= 1 &&
    typeof value.occurred_at === 'string' &&
    Number.isFinite(Date.parse(value.occurred_at)) &&
    typeof value.correlation_id === 'string' &&
    value.correlation_id.length > 0 &&
    value.correlation_id === message.properties.correlationId &&
    (causationId === null ||
      (typeof causationId === 'string' && causationId.length > 0)) &&
    (operationId === null ||
      (typeof operationId === 'string' && uuid.test(operationId))) &&
    value.producer === route.producer &&
    value.kind === route.kind &&
    value.name === message.fields.routingKey &&
    message.properties.type === message.fields.routingKey &&
    message.properties.contentType === 'application/json' &&
    message.fields.exchange === exchange
  );
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
  private failureCount = 0;
  private state: CatalogResultConsumerState = 'NOT_CONFIGURED';
  private active: Promise<void> | null = null;
  private processingTail: Promise<void> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private replayTimer: NodeJS.Timeout | null = null;
  private replaying = false;
  private replayRequested = false;

  constructor(
    private readonly repository: BulkPersistenceRepository,
    @Inject(BULK_AMQP_URL) private readonly amqpUrl: string | null,
    @Optional()
    @Inject(BULK_CONTRACT_RESULT_DISPATCHER)
    private readonly contractResultDispatcher: BulkContractResultDispatcher | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.amqpUrl) return;
    await this.connectConsumer();
  }

  getOperationalState(): CatalogResultConsumerState {
    return this.state;
  }

  private async connectConsumer(): Promise<void> {
    if (!this.amqpUrl || this.stopping || this.paused || this.channel) return;
    this.state = 'CONNECTING';
    try {
      const connection = await amqp.connect(this.amqpUrl);
      this.connection = connection;
      connection.on('error', () => undefined);
      connection.on('close', () => {
        if (this.connection !== connection) return;
        this.channel = null;
        this.connection = null;
        this.consumerTag = null;
        if (!this.stopping) this.scheduleReconnect();
      });
      const channel = await connection.createChannel();
      this.channel = channel;
      channel.on('close', () => {
        if (this.channel !== channel) return;
        this.channel = null;
        this.consumerTag = null;
        if (!this.stopping) this.scheduleReconnect();
      });
      await channel.prefetch(20);
      const result = await channel.consume(
        QUEUE,
        (message) => {
          if (!message || this.stopping || this.paused) return;
          this.processingTail = this.processingTail
            .then(() => this.handle(message, channel))
            .catch(() => this.recoverTransport(channel));
          this.active = this.processingTail.finally(() => {
            this.active = null;
          });
        },
        { noAck: false },
      );
      this.consumerTag = result.consumerTag;
      this.failureCount = 0;
      this.state = 'READY';
      void this.replayPendingContractResults();
    } catch (error) {
      this.state = isTopologyFailure(error) ? 'TOPOLOGY_BLOCKED' : 'RECOVERING';
      this.failureCount = Math.min(this.failureCount + 1, 8);
      this.logger.warn(
        'Consumidor Catalog no disponible; se reintentará con backoff.',
      );
      await this.closeTransport();
      this.scheduleReconnect();
    }
  }

  private async handle(
    message: ConsumeMessage,
    channel: Channel,
  ): Promise<void> {
    if (this.channel !== channel) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(message.content.toString('utf8')) as unknown;
    } catch {
      await this.persistInvalidAndAck(message, channel, 'INVALID_JSON');
      return;
    }

    if (OTHER_BULK_ROUTES.has(message.fields.routingKey)) {
      if (!validateOtherContractEnvelope(decoded, message)) {
        await this.persistInvalidAndAck(
          message,
          channel,
          'INVALID_CONTRACT_ENVELOPE',
        );
        return;
      }
      const pending = decoded as Record<string, unknown>;
      try {
        await this.repository.persistPendingContractResult({
          messageId: String(pending.message_id),
          eventName: String(pending.name),
          correlationId: String(pending.correlation_id),
          payload: pending,
        });
        this.ackIfCurrent(channel, message);
        void this.replayPendingContractResults();
      } catch {
        await this.recoverTransport(channel);
      }
      return;
    }

    let envelope: Envelope;
    try {
      envelope = validateEnvelope(decoded, message);
    } catch {
      await this.persistInvalidAndAck(
        message,
        channel,
        'INVALID_CATALOG_RESULT',
      );
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
        this.ackIfCurrent(channel, message);
        return;
      } catch (error) {
        if (error instanceof BulkDomainError) {
          try {
            await this.repository.persistPendingContractResult({
              messageId: envelope.message_id,
              eventName: envelope.name,
              correlationId: envelope.correlation_id,
              payload: envelope as unknown as Record<string, unknown>,
            });
            this.ackIfCurrent(channel, message);
            void this.replayPendingContractResults();
          } catch {
            await this.recoverTransport(channel);
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
      'Consumidor Catalog recuperará el transporte tras fallos técnicos; la entrega queda sin ACK.',
    );
    await this.recoverTransport(channel);
  }

  private async persistInvalidAndAck(
    message: ConsumeMessage,
    channel: Channel,
    disposition: string,
  ): Promise<void> {
    const transportId = message.properties.messageId;
    if (!transportId) return this.recoverTransport(channel);
    const digest = createHash('sha256').update(message.content).digest('hex');
    try {
      await this.repository.processInboxOnce(
        {
          messageId: transportId,
          handler: 'bulk.catalog.invalid-result',
          eventName: message.fields.routingKey,
          correlationId: message.properties.correlationId ?? null,
          payload: { disposition, content_sha256: digest },
        },
        async () => 'DURABLY_REJECTED',
      );
      this.ackIfCurrent(channel, message);
    } catch {
      await this.recoverTransport(channel);
    }
  }

  private ackIfCurrent(channel: Channel, message: ConsumeMessage): void {
    if (this.channel === channel) channel.ack(message);
  }

  async replayPendingContractResults(): Promise<void> {
    if (this.stopping) return;
    if (this.replaying) {
      this.replayRequested = true;
      return;
    }
    this.replaying = true;
    let hasPending = false;
    try {
      const supportedRoutes = this.contractResultDispatcher
        ? [...RESULT_ROUTES, ...OTHER_BULK_ROUTES.keys()]
        : [...RESULT_ROUTES];
      const unsupportedRoutes = [...OTHER_BULK_ROUTES.keys()].filter(
        (route) => !supportedRoutes.includes(route),
      );
      const pending = await this.repository.listPendingContractResults(
        100,
        supportedRoutes,
      );
      hasPending = pending.length > 0;
      if (unsupportedRoutes.length) {
        const blocked =
          await this.repository.countPendingContractResults(unsupportedRoutes);
        if (blocked > 0)
          this.logger.warn(
            `Hay ${blocked} resultados externos durables pendientes sin dispatcher habilitado; rutas: ${unsupportedRoutes.join(', ')}.`,
          );
      }
      for (const item of pending) {
        try {
          if (RESULT_ROUTES.has(item.eventName)) {
            const envelope = item.payload as unknown as Envelope;
            await this.repository.recordCatalogBulkResult({
              messageId: envelope.message_id,
              operationId: envelope.operation_id,
              causationId: envelope.causation_id,
              eventName: envelope.name as
                | 'catalog.bulk.upsert.completed'
                | 'catalog.bulk.upsert.rejected',
              correlationId: envelope.correlation_id,
              payload: item.payload,
            });
          } else if (this.contractResultDispatcher) {
            await this.contractResultDispatcher.dispatch(item);
          } else {
            continue;
          }
          await this.repository.markContractResultReplayed(item);
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : 'unknown replay failure';
          this.logger.warn(
            `Replay pendiente para ${item.eventName} (${item.messageId}) no aplicado; permanece durable: ${detail}`,
          );
        }
      }
    } catch {
      this.logger.warn('No se pudo consultar el Inbox pendiente de replay.');
      hasPending = true;
    } finally {
      this.replaying = false;
      if (this.replayRequested) {
        this.replayRequested = false;
        queueMicrotask(() => void this.replayPendingContractResults());
      } else if (hasPending) this.scheduleReplay();
    }
  }

  private scheduleReplay(): void {
    if (this.stopping || this.replayTimer) return;
    this.replayTimer = setTimeout(() => {
      this.replayTimer = null;
      void this.replayPendingContractResults();
    }, 30_000);
    this.replayTimer.unref();
  }

  private async recoverTransport(expectedChannel?: Channel): Promise<void> {
    if (this.stopping) return;
    if (expectedChannel && this.channel !== expectedChannel) return;
    if (this.paused) {
      this.scheduleReconnect();
      return;
    }
    this.paused = true;
    this.state = 'RECOVERING';
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
      this.consumerTag = null;
    }
    await this.closeTransport();
    this.failureCount = Math.min(this.failureCount + 1, 8);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.paused = true;
    const delay = Math.min(
      30_000,
      250 * 2 ** Math.max(0, this.failureCount - 1),
    );
    this.state = this.state === 'TOPOLOGY_BLOCKED' ? this.state : 'RECOVERING';
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.paused = false;
      void this.connectConsumer();
    }, delay);
    this.reconnectTimer.unref();
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
    this.paused = true;
    if (this.channel && this.consumerTag)
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
    await this.processingTail.catch(() => undefined);
    await this.closeTransport();
    this.state = 'NOT_CONFIGURED';
  }
}

function isTopologyFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  const message = Reflect.get(error, 'message');
  return (
    code === 403 ||
    code === 404 ||
    code === 406 ||
    (typeof message === 'string' &&
      /ACCESS_REFUSED|NOT_FOUND|PRECONDITION_FAILED/.test(message))
  );
}
