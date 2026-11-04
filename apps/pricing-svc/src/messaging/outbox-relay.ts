import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import { outbox } from '../persistence/pricing.schema.js';

export function priceEnvelope(row: typeof outbox.$inferSelect) {
  if (
    row.eventName !== 'pricing.price.changed' ||
    row.kind !== 'event' ||
    row.schemaVersion !== 1 ||
    !row.payload ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload)
  )
    throw new Error('Hecho Outbox incompatible.');
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
          .where(isNull(outbox.publishedAt))
          .orderBy(asc(outbox.occurredAt), asc(outbox.id))
          .limit(10)
          .for('update', { skipLocked: true });
        let published = 0;
        for (const row of rows) {
          try {
            const body = priceEnvelope(row);
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('Confirmación AMQP no disponible.')),
                2000,
              );
              try {
                publisher.publish(
                  'po.eventos.x',
                  row.eventName,
                  body,
                  {
                    persistent: true,
                    mandatory: true,
                    contentType: 'application/json',
                    contentEncoding: 'utf-8',
                    messageId: row.messageId,
                    correlationId: row.correlationId,
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
