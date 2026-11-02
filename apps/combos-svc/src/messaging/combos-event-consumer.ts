import {
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
import { createHash } from 'node:crypto';
import {
  CombosRepository,
  InboxMessageConflictError,
} from '../persistence/combos.repository.js';
import { CatalogSkuContextClient } from '../integrations/catalog-sku-context.client.js';

export const COMBOS_QUEUE = 'po.combos.q';
const MAX_ATTEMPTS = 3;
const ROUTES = new Map([
  ['catalog.product.deactivated', { producer: 'catalog-svc', version: 1 }],
  ['catalog.sku.deactivated', { producer: 'catalog-svc', version: 1 }],
  ['inventory.stock.changed', { producer: 'inventory-svc', version: 2 }],
]);
const ENVELOPE_KEYS = new Set([
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
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

class MissingTransportMessageIdError extends Error {}

type EventName =
  | 'catalog.product.deactivated'
  | 'catalog.sku.deactivated'
  | 'inventory.stock.changed';
interface Envelope {
  message_id: string;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id?: string | null;
  operation_id?: string | null;
  producer: string;
  kind: 'event';
  name: EventName;
  data: Record<string, unknown>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateCombosEvent(
  value: unknown,
  message: ConsumeMessage,
): Envelope {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key))
  )
    throw new Error('INVALID_ENVELOPE');
  const name = value.name;
  const expected = typeof name === 'string' ? ROUTES.get(name) : undefined;
  if (
    !expected ||
    typeof value.message_id !== 'string' ||
    !value.message_id.trim() ||
    value.message_id !== message.properties.messageId ||
    !Number.isSafeInteger(value.schema_version) ||
    value.schema_version !== expected.version ||
    !validDate(value.occurred_at) ||
    typeof value.correlation_id !== 'string' ||
    !value.correlation_id.trim() ||
    (![undefined, null].includes(value.causation_id as null | undefined) &&
      (typeof value.causation_id !== 'string' || !value.causation_id.trim())) ||
    (![undefined, null].includes(value.operation_id as null | undefined) &&
      (typeof value.operation_id !== 'string' ||
        !UUID.test(value.operation_id))) ||
    value.producer !== expected.producer ||
    value.kind !== 'event' ||
    message.fields.routingKey !== name ||
    message.properties.type !== name ||
    message.properties.contentType !== 'application/json' ||
    message.properties.correlationId !== value.correlation_id ||
    !object(value.data)
  )
    throw new Error('INVALID_ENVELOPE');

  const data = value.data;
  if (name === 'catalog.product.deactivated') {
    if (
      !exactKeys(data, ['product_id', 'product_version', 'changed_at']) ||
      typeof data.product_id !== 'string' ||
      !data.product_id.trim() ||
      !Number.isSafeInteger(data.product_version) ||
      Number(data.product_version) < 1 ||
      !validDate(data.changed_at)
    )
      throw new Error('INVALID_EVENT');
  } else if (name === 'catalog.sku.deactivated') {
    if (
      !exactKeys(data, ['sku', 'product_id', 'sku_version', 'changed_at']) ||
      typeof data.sku !== 'string' ||
      !data.sku.trim() ||
      typeof data.product_id !== 'string' ||
      !data.product_id.trim() ||
      !Number.isSafeInteger(data.sku_version) ||
      Number(data.sku_version) < 1 ||
      !validDate(data.changed_at)
    )
      throw new Error('INVALID_EVENT');
  } else if (
    !exactKeys(data, [
      'sku',
      'location_id',
      'on_hand',
      'reserved',
      'blocked',
      'available',
      'estado',
      'stock_version',
      'updated_at',
    ]) ||
    typeof data.sku !== 'string' ||
    !data.sku.trim() ||
    typeof data.location_id !== 'string' ||
    !UUID.test(data.location_id) ||
    !['on_hand', 'reserved', 'blocked', 'available', 'stock_version'].every(
      (key) =>
        Number.isSafeInteger(data[key]) &&
        Number(data[key]) >= (key === 'stock_version' ? 1 : 0),
    ) ||
    !['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO'].includes(String(data.estado)) ||
    !validDate(data.updated_at)
  )
    throw new Error('INVALID_EVENT');
  return value as unknown as Envelope;
}

@Injectable()
export class CombosEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CombosEventConsumer.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private stopping = false;
  private paused = false;
  private connecting = false;
  private processing = Promise.resolve();

  constructor(private readonly repository: CombosRepository) {}

  async onModuleInit(): Promise<void> {
    if (process.env.COMBOS_AMQP_ENABLED !== 'true') return;
    const url = process.env.COMBOS_AMQP_URL;
    if (!url) throw new Error('COMBOS_AMQP_URL_REQUIRED');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('COMBOS_AMQP_URL_INVALID');
    }
    if (
      !['amqp:', 'amqps:'].includes(parsed.protocol) ||
      parsed.pathname === '/' ||
      !parsed.hostname
    )
      throw new Error('COMBOS_AMQP_URL_INVALID');
    await this.connect(url);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    await this.processing;
  }

  private async connect(url: string): Promise<void> {
    if (this.connecting || this.stopping || this.paused) return;
    this.connecting = true;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          this.connection = await amqp.connect(url, {
            timeout: 2000,
            rejectUnauthorized: true,
          });
          this.connection.on('error', () => undefined);
          this.connection.on('close', () => {
            this.channel = null;
            this.connection = null;
            this.consumerTag = null;
            if (!this.stopping) void this.connect(url);
          });
          this.channel = await this.connection.createChannel();
          this.channel.on('error', () => undefined);
          this.channel.on('close', () => {
            this.channel = null;
            this.consumerTag = null;
          });
          await this.channel.prefetch(20);
          const result = await this.channel.consume(
            COMBOS_QUEUE,
            (message) => {
              if (!message || this.stopping || this.paused) return;
              this.processing = this.processing.then(() =>
                this.handle(message),
              );
            },
            { noAck: false },
          );
          this.consumerTag = result.consumerTag;
          this.logger.log(
            JSON.stringify({ event: 'consumer_ready', queue: COMBOS_QUEUE }),
          );
          return;
        } catch {
          await this.closeTransport();
          if (attempt < MAX_ATTEMPTS) await delay(attempt * 200);
        }
      }
      this.pause('RABBITMQ_UNAVAILABLE');
    } finally {
      this.connecting = false;
    }
  }

  private async handle(message: ConsumeMessage): Promise<void> {
    if (this.stopping || this.paused) return;
    const channel = this.channel;
    if (!channel) return;
    try {
      await this.processDelivery(message);
      channel.ack(message);
    } catch (error) {
      if (error instanceof MissingTransportMessageIdError) {
        this.pause('INVALID_WITHOUT_MESSAGE_ID');
        return;
      }
      if (error instanceof InboxMessageConflictError) {
        await this.recordConflict(message);
        return;
      }
      await this.retryOrPause(message, 'MESSAGE_DISPOSITION_FAILED');
    }
  }

  private async processDelivery(message: ConsumeMessage): Promise<void> {
    const transportId = message.properties.messageId;
    let envelope: Envelope;
    try {
      if (message.properties.contentType !== 'application/json')
        throw new Error('INVALID_ENVELOPE');
      envelope = validateCombosEvent(
        JSON.parse(message.content.toString('utf8')) as unknown,
        message,
      );
    } catch {
      if (!transportId?.trim()) throw new MissingTransportMessageIdError();
      const result = await this.repository.processEvent({
        messageId: transportId,
        handler: 'combos.invalid-event',
        eventName: message.fields.routingKey.slice(0, 200) || 'invalid',
        correlationId: (message.properties.correlationId ?? 'unknown').slice(
          0,
          200,
        ),
        operationId: null,
        payload: {
          disposition: 'REJECTED_INVALID_EVENT',
          content_sha256: createHash('sha256')
            .update(message.content)
            .digest('hex'),
        },
        disposition: 'REJECTED_INVALID_EVENT',
      });
      this.logDisposition(
        transportId,
        message.properties.correlationId,
        result,
      );
      return;
    }

    const data = envelope.data;
    if (envelope.name === 'catalog.product.deactivated') {
      const catalogUrl = process.env.COMBOS_CATALOG_URL;
      if (!catalogUrl) throw new Error('CATALOG_MAPPING_NOT_CONFIGURED');
      const catalog = new CatalogSkuContextClient(
        catalogUrl,
        () => process.env.COMBOS_CATALOG_SERVICE_BEARER,
      );
      const resolveProductSkus = async (candidates: string[]) => {
        const contexts = await Promise.all(
          candidates.map((sku) =>
            catalog.getContextForMapping(sku, envelope.correlation_id),
          ),
        );
        return contexts
          .filter((context) => context.productId === data.product_id)
          .map((context) => context.sku);
      };
      const result = await this.repository.processEvent({
        messageId: envelope.message_id,
        handler: `combos.${envelope.name}`,
        eventName: envelope.name,
        correlationId: envelope.correlation_id,
        operationId:
          typeof envelope.operation_id === 'string'
            ? envelope.operation_id
            : null,
        payload: envelope as unknown as Record<string, unknown>,
        disposition: 'PROCESSED',
        resolveProductSkus,
        changedAt: String(data.changed_at),
      });
      this.logDisposition(envelope.message_id, envelope.correlation_id, result);
      return;
    }
    const result = await this.repository.processEvent({
      messageId: envelope.message_id,
      handler: `combos.${envelope.name}`,
      eventName: envelope.name,
      correlationId: envelope.correlation_id,
      operationId:
        typeof envelope.operation_id === 'string'
          ? envelope.operation_id
          : null,
      payload: envelope as unknown as Record<string, unknown>,
      disposition: 'PROCESSED',
      ...(typeof data.sku === 'string' ? { sku: data.sku } : {}),
      changedAt: String(data.changed_at ?? data.updated_at),
    });
    this.logDisposition(envelope.message_id, envelope.correlation_id, result);
  }

  private async retryOrPause(
    message: ConsumeMessage,
    code: string,
  ): Promise<void> {
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await delay(attempt * 100);
      try {
        await this.processDelivery(message);
        if (this.channel) this.channel.ack(message);
        this.logDisposition(
          message.properties.messageId ?? 'unknown',
          message.properties.correlationId,
          'PROCESSED_AFTER_RETRY',
        );
        return;
      } catch {
        // Keep the delivery unacknowledged until the bounded retry budget is exhausted.
      }
    }
    this.pause(code);
  }

  private async recordConflict(message: ConsumeMessage): Promise<void> {
    const messageId = message.properties.messageId;
    if (!messageId?.trim()) {
      this.pause('CONFLICT_WITHOUT_MESSAGE_ID');
      return;
    }
    try {
      const result = await this.repository.processEvent({
        messageId,
        handler: 'combos.invalid-event',
        eventName: message.fields.routingKey.slice(0, 200) || 'invalid',
        correlationId: (message.properties.correlationId ?? 'unknown').slice(
          0,
          200,
        ),
        operationId: null,
        payload: {
          disposition: 'REJECTED_MESSAGE_ID_CONFLICT',
          content_sha256: createHash('sha256')
            .update(message.content)
            .digest('hex'),
        },
        disposition: 'REJECTED_INVALID_EVENT',
      });
      if (this.channel) this.channel.ack(message);
      this.logDisposition(messageId, message.properties.correlationId, result);
    } catch {
      await this.retryOrPause(message, 'INBOX_CONFLICT_NOT_DURABLE');
    }
  }

  private logDisposition(
    messageId: string,
    correlationId: string | undefined,
    result: string,
  ) {
    this.logger.log(
      JSON.stringify({
        event: 'message_disposed',
        message_id: safeLog(messageId),
        correlation_id: safeLog(correlationId ?? ''),
        result,
      }),
    );
  }

  private pause(code: string): void {
    if (this.paused) return;
    this.paused = true;
    this.logger.warn(JSON.stringify({ event: 'consumer_paused', code }));
    const channel = this.channel;
    const tag = this.consumerTag;
    this.consumerTag = null;
    if (channel && tag) void channel.cancel(tag).catch(() => undefined);
  }

  private async closeTransport(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
  }
}

function safeLog(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join('')
    .slice(0, 128);
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
