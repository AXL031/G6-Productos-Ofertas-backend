import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type Message,
} from 'amqplib';
import { BulkPersistenceRepository } from '../persistence/bulk.repository.js';
import { BULK_AMQP_URL } from './bulk-rabbitmq.js';

const EXCHANGE = 'po.comandos.x';

@Injectable()
export class BulkOutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BulkOutboxRelay.name);
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private failureCount = 0;
  private retryAfter = 0;
  private paused = false;
  private activeFlush: Promise<void> | null = null;
  private readonly returned = new Set<string>();

  constructor(
    private readonly repository: BulkPersistenceRepository,
    @Inject(BULK_AMQP_URL) private readonly amqpUrl: string | null,
  ) {}

  onModuleInit(): void {
    if (!this.amqpUrl) return;
    this.timer = setInterval(() => {
      this.activeFlush = this.flush().finally(() => {
        this.activeFlush = null;
      });
    }, 1000);
    this.timer.unref();
    this.activeFlush = this.flush().finally(() => {
      this.activeFlush = null;
    });
  }

  async flush(): Promise<void> {
    if (
      !this.amqpUrl ||
      this.running ||
      this.stopping ||
      this.paused ||
      Date.now() < this.retryAfter
    )
      return;
    this.running = true;
    try {
      const channel = await this.getChannel();
      const pending = await this.repository.findPendingOutbox(50);
      for (const item of pending) {
        const payload = Buffer.from(JSON.stringify(item.payload), 'utf8');
        this.returned.delete(item.messageId);
        const accepted = channel.publish(EXCHANGE, item.eventName, payload, {
          mandatory: true,
          persistent: true,
          contentType: 'application/json',
          messageId: item.messageId,
          correlationId: item.correlationId,
          type: item.eventName,
          timestamp: Math.floor(item.occurredAt.getTime() / 1000),
        });
        if (!accepted)
          await new Promise<void>((resolve) => channel.once('drain', resolve));
        await channel.waitForConfirms();
        if (this.returned.has(item.messageId)) {
          await this.repository.markOutboxPublished(item.messageId, {
            attempts: item.attempts + 1,
            lastError: 'PUBLICATION_UNROUTED',
          });
          this.paused = true;
          this.logger.warn(
            'Relay Outbox pausado por una publicación confirmada sin ruta; el comando permanece pendiente.',
          );
          return;
        }
        await this.repository.markOutboxPublished(item.messageId, {
          publishedAt: new Date(),
          attempts: item.attempts + 1,
        });
      }
      this.failureCount = 0;
      this.retryAfter = 0;
    } catch {
      this.failureCount = Math.min(this.failureCount + 1, 8);
      const backoffMs = Math.min(30_000, 250 * 2 ** (this.failureCount - 1));
      this.retryAfter = Date.now() + backoffMs;
      this.logger.warn(
        'Relay Outbox indisponible; los comandos permanecen pendientes y se reintentará con backoff limitado.',
      );
      await this.closeTransport();
    } finally {
      this.running = false;
    }
  }

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(this.amqpUrl!);
    connection.on('error', () => void this.closeTransport());
    connection.on('close', () => {
      this.connection = null;
      this.channel = null;
    });
    const channel = await connection.createConfirmChannel();
    channel.on('return', (message: Message) => {
      if (message.properties.messageId)
        this.returned.add(message.properties.messageId);
    });
    this.connection = connection;
    this.channel = channel;
    return channel;
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
    if (this.timer) clearInterval(this.timer);
    await this.activeFlush?.catch(() => undefined);
    await this.closeTransport();
  }
}
