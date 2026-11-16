import { connectPrivateAmqps } from '../private-amqps.js';
import { decodeAuditEnvelope } from './audit-envelope.js';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import { PRICE_AUDIT_CONFIG, type AuditConfig } from '../config/environment.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import { validateChange, type AuditChange } from '../domain/audit.js';
import {
  AuditHttpError,
  AuditPersistenceError,
} from '../http/audit-http.error.js';

export const AUDIT_PRICE_CHANGE_DECODER = Symbol('AUDIT_PRICE_CHANGE_DECODER');
export type AuditPriceChangeDecoder = (
  data: Record<string, unknown>,
  occurredAt: Date,
) => AuditChange[];
export function decodeEnvelope(message: ConsumeMessage) {
  return decodeAuditEnvelope(message.content, message.properties);
}
@Injectable()
export class AuditConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  available = false;
  paused = false;
  private stopped = false;
  private connection?: ChannelModel;
  private channel?: Channel;
  private timer?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;
  private delay = 250;
  private readonly active = new Set<Promise<void>>();
  private readonly logger = new Logger(AuditConsumer.name);
  constructor(
    @Inject(AuditRepository) private readonly repository: AuditRepository,
    @Inject(PRICE_AUDIT_CONFIG) private readonly config: AuditConfig,
    @Optional()
    @Inject(AUDIT_PRICE_CHANGE_DECODER)
    private readonly decoder?: AuditPriceChangeDecoder,
  ) {}
  onApplicationBootstrap() {
    if (!this.config.amqpUrl) return;
    if (!this.decoder)
      throw new Error(
        'P-AUD-02: falta un decoder aprobado de pricing.price.changed.',
      );
    this.start();
  }
  start() {
    if (
      !this.config.amqpUrl ||
      !this.decoder ||
      this.stopped ||
      this.connecting ||
      this.connection
    )
      return;
    this.paused = false;
    clearTimeout(this.timer);
    this.connecting = this.open()
      .catch(() => {
        this.available = false;
        this.logger.warn('AMQP de auditoría temporalmente no disponible.');
      })
      .finally(() => {
        this.connecting = undefined;
        if (!this.stopped && !this.connection && !this.paused) this.retry();
      });
  }
  private retry() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), this.delay);
    this.timer.unref();
    this.delay = Math.min(this.delay * 2, 5000);
  }
  private async open() {
    const connection = await connectPrivateAmqps(
      connect,
      this.config.amqpUrl!,
      {
        timeout: 2000,
        rejectUnauthorized: true,
      },
    );
    this.connection = connection;
    connection.on('error', () => {
      this.available = false;
    });
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.channel = undefined;
        this.available = false;
        if (!this.stopped && !this.paused) this.retry();
      }
    });
    try {
      const channel = await connection.createChannel();
      this.channel = channel;
      channel.on('error', () => {
        this.available = false;
      });
      channel.on('close', () => {
        if (!this.stopped && this.channel === channel)
          void connection.close().catch(() => undefined);
      });
      await channel.checkQueue('po.auditoria-precios.q');
      await channel.prefetch(20);
      await channel.consume(
        'po.auditoria-precios.q',
        (message) => {
          if (!message) {
            this.available = false;
            void connection.close().catch(() => undefined);
            return;
          }
          const work = this.handle(channel, message);
          this.active.add(work);
          void work.finally(() => this.active.delete(work));
        },
        { noAck: false },
      );
      this.available = true;
      this.delay = 250;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }
  private async handle(channel: Channel, message: ConsumeMessage) {
    try {
      const envelope = decodeEnvelope(message);
      let entries: AuditChange[];
      try {
        entries = this.decoder!(envelope.data, envelope.occurredAt);
        if (!Array.isArray(entries) || !entries.length) throw new Error();
        entries = entries.map(validateChange);
      } catch {
        throw new AuditHttpError(400, 'VALIDACION');
      }
      await this.repository.append(envelope, entries);
      channel.ack(message);
    } catch (error) {
      this.available = false;
      // Sin DLQ homologada no se descarta un mensaje: se conserva en la misma cola.
      if (!(error instanceof AuditPersistenceError)) this.paused = true;
      this.logger.warn(
        this.paused
          ? 'Consumo de auditoría pausado por mensaje incompatible.'
          : 'AMQP de auditoría temporalmente no disponible.',
      );
      try {
        channel.nack(message, false, true);
      } catch {
        /* El cierre ya devuelve las entregas sin ACK. */
      }
      await this.connection?.close().catch(() => undefined);
    }
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.connecting;
    await this.connection?.close().catch(() => undefined);
    await Promise.all(this.active);
    this.available = false;
  }
}
