import {
  Injectable,
  Inject,
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
import { createHash, randomUUID } from 'node:crypto';
import {
  CombosRepository,
  InboxMessageConflictError,
} from '../persistence/combos.repository.js';
import {
  CatalogSkuContextClient,
  IntegrationFailure,
} from '../integrations/catalog-sku-context.client.js';
import { CombosServiceIdentity } from '../integrations/combos-service-identity.js';

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
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hours = Number(parts[4]);
  const minutes = Number(parts[5]);
  const seconds = Number(parts[6]);
  const offsetHours = Number(parts[8] ?? 0);
  const offsetMinutes = Number(parts[9] ?? 0);
  const monthDays = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    year >= 1 &&
    day >= 1 &&
    day <= monthDays[month - 1]! &&
    hours <= 23 &&
    minutes <= 59 &&
    seconds <= 59 &&
    (parts[7] === 'Z' ||
      (offsetHours <= 14 &&
        offsetMinutes <= 59 &&
        (offsetHours < 14 || offsetMinutes === 0))) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateCombosEvent(
  value: unknown,
  message: ConsumeMessage,
): Envelope {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !ENVELOPE_KEYS.has(key) && !/^x-[a-z0-9][a-z0-9-]*$/i.test(key),
    )
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
  private enabled = false;
  private processing = Promise.resolve();

  constructor(
    private readonly repository: CombosRepository,
    @Optional()
    @Inject(CombosServiceIdentity)
    private readonly identity?: CombosServiceIdentity,
  ) {}

  private serviceBearer(signal?: AbortSignal) {
    if (this.identity)
      return this.identity.authorization('catalogo:leer', signal);
    if (process.env.COMBOS_TEST_EPHEMERAL === '1')
      return Promise.resolve(process.env.COMBOS_CATALOG_SERVICE_BEARER);
    return Promise.resolve(undefined);
  }

  async onModuleInit(): Promise<void> {
    if (
      process.env.COMBOS_AMQP_ENABLED === undefined ||
      process.env.COMBOS_AMQP_ENABLED === 'false'
    )
      return;
    if (process.env.COMBOS_AMQP_ENABLED !== 'true')
      throw new Error('COMBOS_AMQP_ENABLED_INVALID');
    this.enabled = true;
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

  readinessStatus(): 'disabled' | 'ready' | 'not_ready' {
    if (!this.enabled) return 'disabled';
    return this.connection &&
      this.channel &&
      this.consumerTag &&
      !this.paused &&
      !this.stopping
      ? 'ready'
      : 'not_ready';
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    const channel = this.channel;
    const tag = this.consumerTag;
    if (channel && tag) await channel.cancel(tag).catch(() => undefined);
    await this.processing;
    await channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
  }

  private async connect(url: string): Promise<void> {
    if (
      this.connecting ||
      this.stopping ||
      this.paused ||
      this.connection ||
      this.channel ||
      this.consumerTag
    )
      return;
    this.connecting = true;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          this.connection = await amqp.connect(url, {
            timeout: 2000,
            rejectUnauthorized: true,
          });
          const connection = this.connection;
          connection.on('error', () => {
            if (this.connection !== connection) return;
            this.channel = null;
            this.connection = null;
            this.consumerTag = null;
          });
          connection.on('close', () => {
            if (this.connection === connection) {
              this.channel = null;
              this.connection = null;
              this.consumerTag = null;
            }
            if (!this.stopping) void this.connect(url);
          });
          this.channel = await connection.createChannel();
          const channel = this.channel;
          channel.on('error', () => {
            if (this.channel !== channel) return;
            this.channel = null;
            this.consumerTag = null;
            void connection.close().catch(() => undefined);
          });
          channel.on('close', () => {
            if (this.channel === channel) {
              this.channel = null;
              this.consumerTag = null;
            }
            if (!this.stopping) void connection.close().catch(() => undefined);
          });
          channel.on('cancel', (fields: { consumerTag: string }) => {
            if (fields.consumerTag === this.consumerTag)
              this.pause('SUBSCRIPTION_CANCELLED', false);
          });
          await channel.prefetch(20);
          const result = await channel.consume(
            COMBOS_QUEUE,
            (message) => {
              if (!message) {
                this.pause('SUBSCRIPTION_CANCELLED', false);
                return;
              }
              if (this.stopping || this.paused) return;
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
      if (message.content.byteLength > 1024 * 1024)
        throw new Error('MESSAGE_TOO_LARGE');
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
        correlationId: rejectedCorrelation(message.properties.correlationId),
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
        (signal) => this.serviceBearer(signal),
        fetch,
        () => this.identity?.invalidate('catalogo:leer'),
      );
      const catalogRequestCorrelationId = UUID.test(envelope.correlation_id)
        ? envelope.correlation_id
        : randomUUID();
      if (catalogRequestCorrelationId !== envelope.correlation_id) {
        this.logger.log(
          JSON.stringify({
            event: 'catalog_request_correlation_mapped',
            message_id: safeLog(envelope.message_id),
            event_correlation_id: safeLog(envelope.correlation_id),
            catalog_request_correlation_id: safeLog(
              catalogRequestCorrelationId,
            ),
          }),
        );
      }
      const mappingDeadline = AbortSignal.timeout(15000);
      const resolveProductSkus = async (candidates: string[]) => {
        const contexts = await mapWithConcurrency(
          candidates,
          8,
          async (sku) => {
            try {
              return await catalog.getContextForMapping(
                sku,
                catalogRequestCorrelationId,
                mappingDeadline,
              );
            } catch (error) {
              // Product resolution scans combo references. A SKU no longer present
              // in Catalog cannot belong to this product; other failures remain retryable.
              if (
                error instanceof IntegrationFailure &&
                error.dependency === 'CATALOG' &&
                error.reason === 'SKU_NO_ENCONTRADO'
              )
                return undefined;
              throw error;
            }
          },
        );
        return contexts
          .filter(
            (context): context is NonNullable<typeof context> =>
              context?.productId === data.product_id,
          )
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
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.repository.processEvent({
          messageId,
          handler: 'combos.invalid-event',
          eventName: message.fields.routingKey.slice(0, 200) || 'invalid',
          correlationId: rejectedCorrelation(message.properties.correlationId),
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
        this.logDisposition(
          messageId,
          message.properties.correlationId,
          result,
        );
        return;
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'conflict_disposition_failed',
            message_id: safeLog(messageId),
            code: safeErrorCode(error),
            attempt,
          }),
        );
        if (attempt < MAX_ATTEMPTS) await delay(attempt * 100);
      }
    }
    this.pause('INBOX_CONFLICT_NOT_DURABLE');
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

  private pause(code: string, cancelSubscription = true): void {
    if (this.paused) return;
    this.paused = true;
    this.logger.warn(JSON.stringify({ event: 'consumer_paused', code }));
    const channel = this.channel;
    const tag = this.consumerTag;
    this.consumerTag = null;
    if (cancelSubscription && channel && tag)
      void channel.cancel(tag).catch(() => undefined);
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
function safeErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  if ('code' in error && typeof error.code === 'string')
    return error.code.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, '_');
  if ('name' in error && typeof error.name === 'string')
    return error.name.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, '_');
  return 'UNKNOWN';
}
function rejectedCorrelation(value: string | undefined): string {
  const clean = value ? safeLog(value).trim() : '';
  return clean ? clean.slice(0, 200) : randomUUID();
}
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
