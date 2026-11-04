import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import amqp from 'amqplib';
import {
  InventoryCommandService,
  InventoryMessageError,
} from './inventory-command.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { SanitizedLogger } from '../logging/sanitized-logger.js';
import { deadline } from '../workers/deadline.js';

@Injectable()
export class InventoryConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new SanitizedLogger(
    new Logger(InventoryConsumerService.name),
  );
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private connecting = false;
  private stopping = false;
  private pauseReason: string | null = null;
  private inFlight = new Set<Promise<void>>();
  private readonly counters = {
    received: 0,
    acknowledged: 0,
    duplicates: 0,
    rejected: 0,
    failures: 0,
    reconnects: 0,
  };

  constructor(private readonly commands: InventoryCommandService) {}

  onModuleInit(): void {
    void this.start();
  }

  getMetrics() {
    return {
      ...this.counters,
      connected: this.channel !== null,
      paused: this.pauseReason !== null,
      pauseReason: this.pauseReason,
    };
  }

  /** Reanudación explícita después de resolver el contrato, mensaje o dependencia. Sin endpoint público. */
  async resume(): Promise<void> {
    this.pauseReason = null;
    await this.start();
  }

  async start(): Promise<void> {
    const { rabbitMqUrl } = loadInventoryConfig();
    if (
      !rabbitMqUrl ||
      this.stopping ||
      this.pauseReason ||
      this.connecting ||
      this.channel
    )
      return;
    this.connecting = true;
    try {
      this.connection = await amqp.connect(rabbitMqUrl, { timeout: 5000 });
      const connection = this.connection;
      connection.on('error', (error: Error) =>
        this.logger.error({
          event: 'inventory.consumer.connection_error',
          error,
        }),
      );
      connection.on('close', () => {
        if (this.connection !== connection) return;
        this.channel = null;
        this.connection = null;
        this.scheduleReconnect();
      });
      if (this.stopping) {
        await this.closeConnection();
        return;
      }
      const channel = await deadline(connection.createChannel(), 5000);
      channel.on('error', (error: Error) =>
        this.logger.error({ event: 'inventory.consumer.channel_error', error }),
      );
      channel.on('close', () => {
        if (this.channel !== channel) return;
        this.channel = null;
        void deadline(
          Promise.resolve().then(() => connection.close()),
          3000,
        ).catch(() => undefined);
      });
      if (this.stopping) {
        await this.closeConnection();
        return;
      }
      // La topología es propiedad de infraestructura: no crear ni cambiar queues/exchanges.
      await deadline(channel.checkQueue('po.inventario.q'), 5000);
      await deadline(channel.prefetch(20), 5000);
      if (this.stopping) {
        await this.closeConnection();
        return;
      }
      this.channel = channel;
      await deadline(
        channel.consume(
          'po.inventario.q',
          (message) => {
            if (!message) {
              void this.pause('CONSUMER_CANCELLED', channel);
              return;
            }
            const operation = this.deliver(channel, message);
            this.inFlight.add(operation);
            void operation.then(
              () => this.inFlight.delete(operation),
              () => this.inFlight.delete(operation),
            );
          },
          { noAck: false },
        ),
        5000,
      );
    } catch (error) {
      this.logger.warn({ event: 'inventory.consumer.connect_failed', error });
      await this.closeConnection();
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  async deliver(
    channel: Pick<amqp.Channel, 'ack' | 'close'>,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    this.counters.received++;
    let correlationId: string | undefined;
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(message.content.toString('utf8'));
      } catch {
        // SyntaxError puede incluir fragmentos del contenido recibido.
        throw new InventoryMessageError('INVALID_MESSAGE');
      }
      if (
        payload &&
        typeof payload === 'object' &&
        'correlation_id' in payload &&
        typeof payload.correlation_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          payload.correlation_id,
        )
      ) {
        correlationId = payload.correlation_id;
      }
      const result = await this.commands.process(payload);
      channel.ack(message);
      this.counters.acknowledged++;
      if (result.duplicate) this.counters.duplicates++;
      if (result.status === 'REJECTED') this.counters.rejected++;
    } catch (error) {
      this.counters.failures++;
      const reason =
        error instanceof InventoryMessageError
          ? error.reason
          : 'DEPENDENCY_OR_PROCESSING_FAILED';
      this.logger.error({
        event: 'inventory.consumer.paused_without_ack',
        correlation_id: correlationId,
        reason,
        error,
      });
      // Sin retry/DLX homologado no publicar en colas alternativas ni hacer requeue en bucle.
      // El cierre deja el mensaje sin ACK para su recuperación; requiere resume/reinicio explícito.
      await this.pause(reason, channel);
    }
  }

  private async pause(
    reason: string,
    channel: Pick<amqp.Channel, 'close'>,
  ): Promise<void> {
    this.pauseReason = reason;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.channel = null;
    await deadline(
      Promise.resolve().then(() => channel.close()),
      3000,
    ).catch(() => undefined);
    await this.closeConnection();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.pauseReason || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.counters.reconnects++;
      void this.start();
    }, 30000);
    this.reconnectTimer.unref();
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    if (connection)
      await deadline(
        Promise.resolve().then(() => connection.close()),
        3000,
      ).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await deadline(Promise.allSettled(this.inFlight), 20000).catch(
      () => undefined,
    );
    await this.closeConnection();
  }
}
