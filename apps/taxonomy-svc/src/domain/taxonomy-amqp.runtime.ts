import {
  Injectable,
  Logger,
  type LoggerService,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import { esUuid } from '../errors/taxonomy.errors.js';
import {
  TaxonomyMessageStore,
  parseChecked,
} from '../persistence/taxonomy-message.store.js';

type Config = { url: string; user: string; catalogUser: string };
export function leerAmqp(env: Readonly<NodeJS.ProcessEnv>): Config | undefined {
  if (!env.RABBITMQ_URL && !env.TAXONOMY_CATALOG_AMQP_USER) return undefined;
  try {
    const url = new URL(env.RABBITMQ_URL ?? '');
    const user = decodeURIComponent(url.username);
    const catalogUser = env.TAXONOMY_CATALOG_AMQP_USER?.trim();
    if (
      !['amqp:', 'amqps:'].includes(url.protocol) ||
      decodeURIComponent(url.pathname.slice(1)) !== 'g6-productos-ofertas' ||
      !user ||
      !url.password ||
      !catalogUser ||
      catalogUser === user
    )
      throw new Error();
    return { url: env.RABBITMQ_URL!, user, catalogUser };
  } catch {
    throw new Error('Configuración AMQP taxonomy inválida');
  }
}

@Injectable()
export class TaxonomyAmqpRuntime implements OnModuleDestroy {
  private logger: LoggerService = new Logger(TaxonomyAmqpRuntime.name);
  private config?: Config;
  private connection?: ChannelModel;
  private consumer?: Channel;
  private publisher?: ConfirmChannel;
  private timer?: ReturnType<typeof setInterval>;
  private cycle?: Promise<void>;
  private stopped = false;
  private paused = false;
  private deliveries = new Set<Promise<void>>();
  constructor(private readonly store: TaxonomyMessageStore) {}

  /** Reemplazable en pruebas sin alterar el logger central del bootstrap. */
  usarLogger(logger: LoggerService): void {
    this.logger = logger;
  }
  configurar(env: Readonly<NodeJS.ProcessEnv>): void {
    this.config = leerAmqp(env);
  }
  disponible(): boolean {
    return (
      !this.config ||
      (!!this.connection && !!this.consumer && !!this.publisher && !this.paused)
    );
  }
  iniciar(): void {
    if (!this.config || this.timer || this.stopped) return;
    const tick = () => {
      if (this.stopped || this.paused || this.cycle) return;
      this.cycle = this.ejecutar()
        .catch(() => {
          this.logger.warn({
            event: 'taxonomy.amqp.unavailable',
            service: 'taxonomy-svc',
            component: 'runtime',
            state: 'unavailable',
            reason: 'CONNECTION_OR_CHANNEL_FAILURE',
          });
        })
        .finally(() => {
          this.cycle = undefined;
        });
    };
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
    tick();
  }
  private async ejecutar(): Promise<void> {
    if (!this.connection) {
      const connection = await connect(this.config!.url, { timeout: 5000 });
      connection.on('error', () => undefined);
      connection.on('close', () => {
        if (this.connection === connection) {
          this.connection = undefined;
          this.consumer = undefined;
          this.publisher = undefined;
        }
      });
      try {
        const consumer = await connection.createChannel();
        const publisher = await connection.createConfirmChannel();
        consumer.on('error', () => undefined);
        publisher.on('error', () => undefined);
        consumer.on('close', () => {
          if (this.connection === connection && !this.stopped)
            void connection.close().catch(() => undefined);
        });
        publisher.on('close', () => {
          if (this.connection === connection && !this.stopped)
            void connection.close().catch(() => undefined);
        });
        await consumer.checkQueue('po.taxonomia.q');
        await consumer.prefetch(1);
        this.connection = connection;
        this.consumer = consumer;
        this.publisher = publisher;
        await consumer.consume(
          'po.taxonomia.q',
          (delivery) => {
            if (!delivery) {
              this.paused = true;
              this.logger.error({ event: 'taxonomy.amqp.consumer_cancelled' });
              return;
            }
            if (this.stopped) return;
            const work = this.handle(delivery, consumer).finally(() =>
              this.deliveries.delete(work),
            );
            this.deliveries.add(work);
          },
          { noAck: false },
        );
      } catch (error) {
        this.connection = undefined;
        this.consumer = undefined;
        this.publisher = undefined;
        await connection.close().catch(() => undefined);
        throw error;
      }
    }
    for (let i = 0; i < 20 && !this.stopped && this.publisher; i++) {
      const estado = await this.store.publicarUno((row) =>
        this.publicar(row, this.publisher!),
      );
      if (estado === 'PENDIENTE') {
        this.logger.warn({
          event: 'taxonomy.amqp.outbox_publish_pending',
          service: 'taxonomy-svc',
          component: 'outbox',
          state: 'pending',
          reason: 'BROKER_PUBLISH_UNCONFIRMED',
        });
      }
      if (estado === 'VACIO') break;
    }
  }
  private async handle(
    delivery: ConsumeMessage,
    consumer: Channel,
  ): Promise<void> {
    const hash = createHash('sha256').update(delivery.content).digest('hex');
    const fallback = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    let envelope;
    try {
      if (
        delivery.content.length > 1024 * 1024 ||
        delivery.properties.contentType !== 'application/json' ||
        delivery.properties.userId !== this.config!.catalogUser
      )
        throw new Error('INVALID_ENVELOPE');
      envelope = parseChecked(
        JSON.parse(delivery.content.toString('utf8')) as unknown,
      );
      if (
        delivery.properties.messageId !== envelope.message_id ||
        delivery.properties.correlationId !== envelope.correlation_id ||
        delivery.fields.routingKey !== envelope.name
      )
        throw new Error('INVALID_ENVELOPE');
    } catch {
      const id =
        typeof delivery.properties.messageId === 'string' &&
        esUuid(delivery.properties.messageId)
          ? delivery.properties.messageId
          : fallback;
      await this.conReintentos(
        () =>
          this.store.guardarInvalido(
            id,
            hash,
            typeof delivery.properties.correlationId === 'string' &&
              esUuid(delivery.properties.correlationId)
              ? delivery.properties.correlationId
              : null,
          ),
        consumer,
        delivery,
      );
      return;
    }
    await this.conReintentos(
      () => this.store.consumir(envelope),
      consumer,
      delivery,
    );
  }
  private async conReintentos(
    accion: () => Promise<void>,
    channel: Channel,
    delivery: ConsumeMessage,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
      try {
        await accion();
        channel.ack(delivery);
        return;
      } catch {
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * (attempt + 1)),
          );
      }
    }
    this.paused = true;
    this.logger.error({
      event: 'taxonomy.amqp.consumer_paused',
      service: 'taxonomy-svc',
      alert_name: 'taxonomy_amqp_consumer_paused',
      component: 'consumer',
      state: 'paused',
      attempts: 3,
      reason: 'PERSISTENCE_FAILURE',
    });
    // La entrega permanece sin ACK; el cierre devuelve el mensaje al broker.
    await channel.cancel(delivery.fields.consumerTag).catch(() => undefined);
  }
  private async publicar(
    row: Record<string, unknown>,
    channel: ConfirmChannel,
  ): Promise<void> {
    const routes: Record<string, string> = {
      'taxonomy.category.updated': 'po.eventos.x',
      'taxonomy.product-type-schema.changed': 'po.eventos.x',
      'taxonomy.characteristic-value.updated': 'po.eventos.x',
      'taxonomy.master.deactivation.check.requested': 'po.comandos.x',
      'taxonomy.master.deactivated': 'po.eventos.x',
      'taxonomy.master.deactivation.rejected': 'po.resultados.x',
    };
    if (
      typeof row.event_name !== 'string' ||
      !routes[row.event_name] ||
      typeof row.message_id !== 'string' ||
      typeof row.correlation_id !== 'string' ||
      !row.payload ||
      typeof row.payload !== 'object' ||
      Array.isArray(row.payload)
    )
      throw new Error('INVALID_OUTBOX');
    const name = row.event_name;
    const id = row.message_id;
    const payload = row.payload as Record<string, unknown>;
    const kind = name.endsWith('.requested')
      ? 'command'
      : name.endsWith('.rejected')
        ? 'result'
        : 'event';
    if (
      payload.name !== name ||
      payload.message_id !== id ||
      payload.correlation_id !== row.correlation_id ||
      payload.producer !== 'taxonomy-svc' ||
      payload.kind !== kind ||
      payload.schema_version !== 1 ||
      typeof payload.data !== 'object' ||
      payload.data === null
    )
      throw new Error('INVALID_OUTBOX');
    await new Promise<void>((resolve, reject) => {
      let returned = false;
      let settled = false;
      const onReturn = (message: ConsumeMessage) => {
        if (message.properties.messageId === id) returned = true;
      };
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.off('return', onReturn);
        if (error || returned) reject(error ?? new Error('UNROUTABLE'));
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error('CONFIRM_TIMEOUT')),
        5000,
      );
      channel.on('return', onReturn);
      try {
        channel.publish(
          routes[name],
          name,
          Buffer.from(JSON.stringify(row.payload)),
          {
            mandatory: true,
            persistent: true,
            contentType: 'application/json',
            messageId: id,
            correlationId: row.correlation_id as string,
            type: name,
            userId: this.config!.user,
          },
          (error) => finish(error),
        );
      } catch {
        finish(new Error('PUBLISH_FAILED'));
      }
    });
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.cycle;
    await Promise.allSettled(this.deliveries);
    if (this.connection) await this.connection.close().catch(() => undefined);
  }
}
