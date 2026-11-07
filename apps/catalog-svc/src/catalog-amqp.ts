import { connectPrivateAmqps } from './private-amqps.js';
import { translatePostgresFailure } from './database-errors.js';
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';
import {
  CatalogMessageService,
  type CatalogPublisher,
} from './catalog-message.service.js';
import {
  InvalidCatalogMessage,
  catalogProduced,
  assertCatalogPublication,
  parseCatalogMessage,
  type CatalogEnvelope,
} from './catalog-messages.js';
import { object } from './catalog-mutation.input.js';
import { CatalogTelemetry, type CatalogSignal } from './catalog-telemetry.js';

export interface CatalogAmqpConfig {
  url: string;
  user: string;
  producerUsers: Record<string, string>;
}
export const CATALOG_AMQP_SETTINGS = Symbol('CATALOG_AMQP_SETTINGS');
export interface CatalogAmqpSettings {
  connection?: CatalogAmqpConfig;
}
export function readCatalogAmqpConfig(
  env: Record<string, string | undefined> = process.env,
): CatalogAmqpConfig | undefined {
  const enabled = env.CATALOG_AMQP_ENABLED;
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true')
    throw new Error('CATALOG_AMQP_ENABLED debe ser true o false.');
  try {
    if (!env.RABBITMQ_URL) throw new Error();
    const url = new URL(env.RABBITMQ_URL);
    const users: unknown = JSON.parse(
      env.CATALOG_AMQP_PRODUCER_USERS ?? 'null',
    );
    if (
      !['amqp:', 'amqps:'].includes(url.protocol) ||
      decodeURIComponent(url.pathname.slice(1)) !== 'g6-productos-ofertas' ||
      !url.username ||
      !url.password ||
      !object(users) ||
      ['pricing-svc', 'inventory-svc', 'taxonomy-svc', 'bulk-svc'].some(
        (k) => typeof users[k] !== 'string' || !users[k],
      )
    )
      throw new Error();
    if (
      new Set(Object.values(users)).size !== Object.values(users).length ||
      Object.values(users).includes(decodeURIComponent(url.username))
    )
      throw new Error();
    return {
      url: env.RABBITMQ_URL,
      user: decodeURIComponent(url.username),
      producerUsers: users as Record<string, string>,
    };
  } catch {
    throw new Error(
      'Configuración RabbitMQ de Catálogo inválida; requiere vhost y usuarios de productores explícitos.',
    );
  }
}

/** Publisher confirms only broker responsibility; a confirm is never business completion. */
export class ConfirmedCatalogPublisher implements CatalogPublisher {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly channel: ConfirmChannel,
    private readonly user: string,
    private readonly timeout = 5000,
  ) {}
  publish(message: CatalogEnvelope): Promise<void> {
    try {
      assertCatalogPublication(message);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!(catalogProduced as readonly string[]).includes(message.name))
      return Promise.reject(new InvalidCatalogMessage());
    const exchange =
      message.kind === 'command'
        ? 'po.comandos.x'
        : message.kind === 'event'
          ? 'po.eventos.x'
          : 'po.resultados.x';
    return this.raw(
      exchange,
      message.name,
      Buffer.from(JSON.stringify(message)),
      {
        messageId: message.message_id,
        correlationId: message.correlation_id,
        type: message.name,
      },
    );
  }
  raw(
    exchange: string,
    key: string,
    content: Buffer,
    properties: Options.Publish,
  ): Promise<void> {
    const work = this.tail.then(() =>
      this.send(exchange, key, content, properties),
    );
    this.tail = work.catch(() => undefined);
    return work;
  }
  private send(
    exchange: string,
    key: string,
    content: Buffer,
    properties: Options.Publish,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let returned = false,
        confirmed = false,
        drained = false,
        finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        if (!error && (!confirmed || !drained)) return;
        finished = true;
        clearTimeout(timer);
        this.channel.off('return', onReturn);
        this.channel.off('close', onClose);
        this.channel.off('error', onClose);
        this.channel.off('drain', onDrain);
        if (error) reject(new Error('AMQP_PUBLISH_UNCONFIRMED'));
        else resolve();
      };
      const onReturn = () => {
        returned = true;
      };
      const onClose = () => finish(new Error());
      const onDrain = () => {
        drained = true;
        finish();
      };
      const timer = setTimeout(() => {
        finish(new Error());
        void this.channel.close().catch(() => undefined);
      }, this.timeout);
      this.channel.on('return', onReturn);
      this.channel.on('close', onClose);
      this.channel.on('error', onClose);
      this.channel.on('drain', onDrain);
      try {
        const writable = this.channel.publish(
          exchange,
          key,
          content,
          {
            ...properties,
            contentType: 'application/json',
            persistent: true,
            mandatory: true,
            userId: this.user,
          },
          (error: unknown) => {
            confirmed = true;
            finish(error || returned ? new Error() : undefined);
          },
        );
        if (writable) {
          drained = true;
          finish();
        }
      } catch {
        finish(new Error());
      }
    });
  }
}

function isTransientPersistenceFailure(error: unknown): boolean {
  const failure = translatePostgresFailure(error)?.failure;
  return (
    failure === 'connection' ||
    failure === 'serialization' ||
    failure === 'deadlock'
  );
}

@Injectable()
export class CatalogAmqpRuntime implements OnModuleInit, OnModuleDestroy {
  private get config() {
    return this.settings.connection;
  }
  private connection?: ChannelModel;
  private consumer?: Channel;
  private consumerTag?: string;
  private publisher?: ConfirmedCatalogPublisher;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private paused = false;
  private subscribed = false;
  private deliveries = new Set<Promise<void>>();
  constructor(
    private readonly messages: CatalogMessageService,
    @Inject(CATALOG_AMQP_SETTINGS)
    private readonly settings: CatalogAmqpSettings = {
      connection: readCatalogAmqpConfig(),
    },
    @Optional()
    private readonly telemetry: CatalogTelemetry = new CatalogTelemetry(),
  ) {}
  get required(): boolean {
    return this.config !== undefined;
  }
  get ready(): boolean {
    return !this.required || (!this.stopped && !this.paused && this.subscribed);
  }
  onModuleInit(): void {
    if (!this.config) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
    this.timer.unref();
    void this.tick();
  }
  private async tick(): Promise<void> {
    if (this.busy || this.stopped || this.paused || !this.config) return;
    this.busy = true;
    try {
      if (!this.connection) {
        const connection = await connectPrivateAmqps(connect, this.config.url, {
          timeout: 5000,
        });
        if (this.stopped) {
          await connection.close();
          return;
        }
        connection.on('error', () => {
          this.subscribed = false;
          this.log('AMQP_CONNECTION_FAILURE');
        });
        connection.on('close', () => {
          if (this.connection === connection) {
            this.connection = undefined;
            this.publisher = undefined;
            this.consumer = undefined;
            this.consumerTag = undefined;
            this.subscribed = false;
          }
        });
        this.connection = connection;
        try {
          const channel = await connection.createConfirmChannel();
          channel.on('error', () => {
            this.subscribed = false;
            this.log('AMQP_CHANNEL_FAILURE');
          });
          channel.on('close', () => {
            void this.reset(connection);
          });
          this.publisher = new ConfirmedCatalogPublisher(
            channel,
            this.config.user,
          );
          this.consumer = await connection.createChannel();
          this.consumer.on('error', () => {
            this.subscribed = false;
            this.log('AMQP_CONSUMER_FAILURE');
          });
          this.consumer.on('close', () => {
            void this.reset(connection);
          });
          await this.consumer.prefetch(1);
          const consumer = this.consumer;
          // Infrastructure owns topology. No assert, bind, purge or declare against shared brokers.
          const subscription = await consumer.consume(
            'po.catalogo.q',
            (delivery) => {
              if (!delivery) {
                this.subscribed = false;
                this.log('AMQP_CONSUMER_CANCELLED');
                void this.reset(connection);
                return;
              }
              const processing = this.handle(
                delivery,
                consumer,
                connection,
              ).catch(() => this.pause(connection));
              this.deliveries.add(processing);
              void processing.finally(() => this.deliveries.delete(processing));
            },
            { noAck: false },
          );
          this.consumerTag = subscription.consumerTag;
          this.subscribed = !this.paused;
          this.log('AMQP_CONNECTED');
        } catch (error) {
          await this.reset(connection);
          throw error;
        }
      }
      for (
        let i = 0;
        i < 20 && !this.stopped && !this.paused && this.publisher;
        i++
      ) {
        if ((await this.messages.relayOne(this.publisher)) !== 'PUBLISHED')
          break;
      }
    } catch {
      this.log('AMQP_CYCLE_PENDING');
    } finally {
      this.busy = false;
    }
  }
  private async handle(
    delivery: ConsumeMessage,
    consumer: Channel,
    connection: ChannelModel,
  ): Promise<void> {
    let message: ReturnType<typeof parseCatalogMessage>;
    try {
      if (
        delivery.content.length > 1024 * 1024 ||
        delivery.properties.contentType !== 'application/json'
      ) {
        throw new InvalidCatalogMessage();
      }
      message = parseCatalogMessage(
        JSON.parse(delivery.content.toString('utf8')) as unknown,
      );
      if (
        delivery.properties.userId !==
          this.config!.producerUsers[message.producer] ||
        delivery.properties.messageId !== message.message_id ||
        delivery.properties.correlationId !== message.correlation_id
      ) {
        throw new InvalidCatalogMessage();
      }
    } catch {
      await this.pause(connection);
      return;
    }

    for (let attempt = 0; attempt <= 3; attempt++) {
      if (this.stopped || this.paused || this.connection !== connection) return;
      try {
        await this.messages.consume(message);
      } catch (error) {
        if (attempt === 3 || !isTransientPersistenceFailure(error)) {
          await this.pause(connection);
          return;
        }
        this.log('AMQP_LOCAL_RETRY');
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 100 * (attempt + 1)),
        );
        continue;
      }
      // The use case resolves only after committing Inbox and business state.
      if (!this.stopped && !this.paused && this.connection === connection)
        consumer.ack(delivery);
      return;
    }
  }

  private async pause(connection: ChannelModel): Promise<void> {
    this.paused = true;
    this.subscribed = false;
    this.log('AMQP_CONSUMER_PAUSED');
    // Closing the channel/connection returns unacked deliveries to RabbitMQ.
    // A normal network reconnect cannot clear this process-level pause.
    const consumer = this.consumer;
    const tag = this.consumerTag;
    if (this.connection === connection && consumer && tag) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          consumer.cancel(tag).catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await this.reset(connection);
  }
  private async reset(connection: ChannelModel): Promise<void> {
    if (this.connection === connection) {
      this.connection = undefined;
      this.consumer = undefined;
      this.consumerTag = undefined;
      this.publisher = undefined;
      this.subscribed = false;
    }
    await connection.close().catch(() => undefined);
  }
  private log(code: CatalogSignal): void {
    this.telemetry.record(code);
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const consumer = this.consumer;
    const tag = this.consumerTag;
    const connection = this.connection;
    this.subscribed = false;
    this.consumerTag = undefined;
    let closePromise: Promise<void> | undefined;
    const closeConnection = () =>
      (closePromise ??= connection
        ? this.reset(connection)
        : Promise.resolve());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const boundedCancel =
      consumer && tag
        ? Promise.race([
            Promise.resolve()
              .then(() => consumer.cancel(tag))
              .then(
                () => true,
                () => false,
              ),
            new Promise<false>((resolve) => {
              cancelTimer = setTimeout(() => resolve(false), 1000);
            }),
          ])
        : Promise.resolve(false);
    try {
      await Promise.race([
        (async () => {
          const cancelled = await boundedCancel;
          if (!cancelled) void closeConnection();
          else await closeConnection();
          await Promise.allSettled(this.deliveries);
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.log('AMQP_SHUTDOWN_PENDING');
            void closeConnection();
            resolve();
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
    }
  }
}
