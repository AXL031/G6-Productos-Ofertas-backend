import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import { outbox } from '../persistence/pricing.schema.js';

const EVENT_NAMES = new Set(['pricing.price.changed']);
const RESULT_NAMES = new Set([
  'pricing.product.initialization.completed',
  'pricing.product.initialization.rejected',
]);

function validResult(name: string, data: Record<string, unknown>): boolean {
  if (!name.startsWith('pricing.product.initialization.')) return false;
  const completed = name.endsWith('.completed');
  return (
    typeof data.product_id === 'string' &&
    data.product_id.length > 0 &&
    typeof data.sku_base === 'string' &&
    data.sku_base.length > 0 &&
    data.status === (completed ? 'READY' : 'REJECTED') &&
    typeof data.completed_at === 'string' &&
    Number.isFinite(Date.parse(data.completed_at)) &&
    (data.price_version === null ||
      (Number.isSafeInteger(data.price_version) &&
        Number(data.price_version) >= 1)) &&
    (data.vigencia_id === null || typeof data.vigencia_id === 'string') &&
    (data.code === null || typeof data.code === 'string') &&
    (completed
      ? Number.isSafeInteger(data.price_version) &&
        typeof data.vigencia_id === 'string' &&
        data.code === null
      : typeof data.code === 'string' &&
        data.code.length > 0 &&
        data.price_version === null &&
        data.vigencia_id === null)
  );
}

function validPriceChanged(data: Record<string, unknown>): boolean {
  const decimal = (value: unknown) =>
    value === null ||
    (typeof value === 'string' && /^\d{1,10}\.\d{2}$/.test(value));
  const actor = object(data.actor) ? data.actor : undefined;
  return (
    [
      'target_type',
      'product_id',
      'sku',
      'channel_id',
      'currency',
      'price_type',
      'previous_price',
      'new_price',
      'operation',
      'reason',
      'price_version',
      'valid_from',
      'batch_id',
      'actor',
    ].every((key) => Object.hasOwn(data, key)) &&
    (data.target_type === 'PRODUCTO' || data.target_type === 'SKU') &&
    typeof data.product_id === 'string' &&
    data.product_id.length > 0 &&
    (data.target_type === 'PRODUCTO'
      ? data.sku === null
      : typeof data.sku === 'string' && data.sku.length > 0) &&
    (data.channel_id === null || typeof data.channel_id === 'string') &&
    typeof data.currency === 'string' &&
    data.currency.length === 3 &&
    (data.price_type === 'REGULAR' || data.price_type === 'OFERTA') &&
    decimal(data.previous_price) &&
    decimal(data.new_price) &&
    (data.operation === 'CREACION' ||
      data.operation === 'MODIFICACION' ||
      data.operation === 'RETIRO_OFERTA') &&
    typeof data.reason === 'string' &&
    data.reason.trim().length > 0 &&
    Number.isSafeInteger(data.price_version) &&
    Number(data.price_version) >= 1 &&
    typeof data.valid_from === 'string' &&
    Number.isFinite(Date.parse(data.valid_from)) &&
    data.batch_id === null &&
    actor !== undefined &&
    (actor.user_id === null || typeof actor.user_id === 'string') &&
    (actor.email === null || typeof actor.email === 'string') &&
    (actor.ip === null || typeof actor.ip === 'string')
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function pricingEnvelope(row: typeof outbox.$inferSelect) {
  const validKind =
    (row.kind === 'event' && EVENT_NAMES.has(row.eventName)) ||
    (row.kind === 'result' && RESULT_NAMES.has(row.eventName));
  if (
    !validKind ||
    row.schemaVersion !== 1 ||
    !row.payload ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload)
  )
    throw new Error('Hecho Outbox incompatible.');
  if (
    row.eventName === 'pricing.price.changed' &&
    !validPriceChanged(row.payload)
  )
    throw new Error('Hecho de cambio de precio incompatible.');
  if (
    row.kind === 'result' &&
    row.eventName.startsWith('pricing.product.initialization.') &&
    !validResult(row.eventName, row.payload)
  )
    throw new Error('Resultado Outbox incompatible.');
  const body = Buffer.from(
    JSON.stringify({
      message_id: row.messageId,
      schema_version: row.schemaVersion,
      occurred_at: row.occurredAt.toISOString(),
      correlation_id: row.correlationId,
      causation_id: row.causationId,
      operation_id: row.operationId,
      producer: 'pricing-svc',
      kind: row.kind,
      name: row.eventName,
      data: row.payload,
    }),
  );
  if (body.length > 1024 * 1024)
    throw new Error('Hecho Outbox excede el límite técnico.');
  return body;
}
@Injectable()
export class PricingOutboxRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  available = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private readonly logger = new Logger(PricingOutboxRelay.name);
  constructor(
    @Inject(PricingRepository) private readonly repository: PricingRepository,
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
  ) {}
  onApplicationBootstrap() {
    if (!this.config.amqpUrl) return;
    const tick = () => {
      this.active = this.runOnce(this.config.amqpUrl!)
        .then(
          (result) => {
            this.available = result.selected === result.published;
          },
          () => {
            this.available = false;
          },
        )
        .then(() => {
          if (!this.available)
            this.logger.warn(
              'Publicación AMQP de Pricing pendiente de recuperación.',
            );
        })
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, 3000);
            this.timer.unref();
          }
        });
    };
    tick();
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
    this.available = false;
  }
  async runOnce(url: string) {
    let connection: ChannelModel | undefined;
    let channel: ConfirmChannel | undefined;
    try {
      const producerUser = decodeURIComponent(new URL(url).username);
      connection = await connect(url, {
        timeout: 2000,
        rejectUnauthorized: true,
      });
      connection.on('error', () => {
        this.available = false;
      });
      channel = await connection.createConfirmChannel();
      channel.on('error', () => {
        this.available = false;
      });
      await channel.checkExchange('po.eventos.x');
      await channel.checkExchange('po.resultados.x');
      const returned = new Set<string>();
      channel.on('return', (message) => {
        if (message.properties.messageId)
          returned.add(message.properties.messageId);
      });
      const publisher = channel;
      return await this.repository.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(outbox)
          .where(
            and(
              isNull(outbox.publishedAt),
              this.config.priceChangedPublishingEnabled === true
                ? undefined
                : ne(outbox.eventName, 'pricing.price.changed'),
            ),
          )
          .orderBy(asc(outbox.occurredAt), asc(outbox.id))
          .limit(10)
          .for('update', { skipLocked: true });
        let published = 0;
        for (const row of rows) {
          try {
            const body = pricingEnvelope(row);
            const exchange =
              row.kind === 'result' ? 'po.resultados.x' : 'po.eventos.x';
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('Confirmación AMQP no disponible.')),
                2000,
              );
              try {
                publisher.publish(
                  exchange,
                  row.eventName,
                  body,
                  {
                    persistent: true,
                    mandatory: true,
                    contentType: 'application/json',
                    contentEncoding: 'utf-8',
                    messageId: row.messageId,
                    correlationId: row.correlationId,
                    userId: producerUser,
                  },
                  (error: unknown) => {
                    clearTimeout(timeout);
                    if (error || returned.has(row.messageId))
                      reject(
                        new Error('Publicación AMQP no confirmada o sin ruta.'),
                      );
                    else resolve();
                  },
                );
              } catch {
                clearTimeout(timeout);
                reject(new Error('Publicación AMQP no disponible.'));
              }
            });
            await tx
              .update(outbox)
              .set({
                publishedAt: new Date(),
                attempts: sql`${outbox.attempts} + 1`,
                lastError: null,
              })
              .where(eq(outbox.id, row.id));
            published++;
          } catch {
            await tx
              .update(outbox)
              .set({
                attempts: sql`${outbox.attempts} + 1`,
                lastError: 'PUBLICACION_NO_CONFIRMADA',
              })
              .where(eq(outbox.id, row.id));
          }
        }
        return { selected: rows.length, published };
      });
    } finally {
      await channel?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
    }
  }
}
