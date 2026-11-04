import { Injectable, Logger, Inject } from '@nestjs/common';
import amqp from 'amqplib';
import { deadline } from '../workers/deadline.js';
import { SanitizedLogger } from '../logging/sanitized-logger.js';
import { DatabaseService } from '../database/database.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { OUTBOX_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type {
  IOutboxRepository,
  OutboxEntity,
} from '../repositories/interfaces/outbox.repository.interface.js';

export interface IMessageBrokerPublisher {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: amqp.Options.Publish,
  ): Promise<boolean>;
}

const MAX_DISPATCH_BATCH_SIZE = 10;
const BROKER_CONNECT_TIMEOUT_MS = 5000;
const PUBLISH_CONFIRM_TIMEOUT_MS = 3000;

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new SanitizedLogger(
    new Logger(OutboxPublisherService.name),
  );
  private customPublisher: IMessageBrokerPublisher | null = null;

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(OUTBOX_REPOSITORY)
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  setCustomPublisher(publisher: IMessageBrokerPublisher | null): void {
    this.customPublisher = publisher;
  }

  /**
   * Despacha eventos PENDING de inventory.outbox hacia RabbitMQ con publisher confirms,
   * entrega obligatoria (mandatory: true) y detección de basic.return como fallo de enrutamiento.
   * Utiliza FOR UPDATE SKIP LOCKED dentro de una transacción para evitar publicaciones duplicadas
   * entre múltiples instancias o dispatchers concurrentes.
   */
  async dispatchPending(limit = 50): Promise<{
    dispatched: number;
    failed: number;
    skipped: boolean;
    reason?:
      'NOT_CONFIGURED' | 'DEPENDENCY_UNAVAILABLE' | 'DATABASE_UNAVAILABLE';
  }> {
    const config = loadInventoryConfig();
    const batchSize = Math.min(
      MAX_DISPATCH_BATCH_SIZE,
      Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1)),
    );

    if (!config.rabbitMqUrl && !this.customPublisher) {
      this.logger.debug(
        'RABBITMQ_URL no configurado; los eventos outbox permanecen durables en estado PENDING.',
      );
      return {
        dispatched: 0,
        failed: 0,
        skipped: true,
        reason: 'NOT_CONFIGURED',
      };
    }

    let amqpConn: amqp.ChannelModel | null = null;
    let confirmChannel: amqp.ConfirmChannel | null = null;
    const returnedMessageIds = new Set<string>();

    try {
      if (!this.customPublisher && config.rabbitMqUrl) {
        amqpConn = await amqp.connect(config.rabbitMqUrl, {
          timeout: BROKER_CONNECT_TIMEOUT_MS,
        });
        amqpConn.on('error', (error: Error) =>
          this.logger.error({
            event: 'inventory.outbox.connection_error',
            error,
          }),
        );
        confirmChannel = await deadline(
          amqpConn.createConfirmChannel(),
          BROKER_CONNECT_TIMEOUT_MS,
        );
        confirmChannel.on('error', (error: Error) =>
          this.logger.error({ event: 'inventory.outbox.channel_error', error }),
        );

        // Escuchar devoluciones cuando un mensaje obligatorio no encuentra cola en el exchange
        confirmChannel.on('return', (returnedMsg) => {
          const msgId = returnedMsg.properties.messageId;
          if (msgId) {
            returnedMessageIds.add(msgId);
          }
          this.logger.warn(
            `Mensaje outbox devuelto por el broker (NO ROUTE / basic.return): messageId=${msgId}, routingKey=${returnedMsg.fields.routingKey}`,
          );
        });
      }

      // Reclamación transaccional con FOR UPDATE SKIP LOCKED
      return await this.databaseService.transaction(async (txClient) => {
        let pendingRows: OutboxEntity[] = [];

        try {
          pendingRows =
            await this.outboxRepository.findPendingForUpdateSkipLocked(
              txClient,
              batchSize,
            );
        } catch (dbErr) {
          this.logger.warn(
            `No fue posible consultar inventory.outbox con FOR UPDATE SKIP LOCKED: ${(dbErr as Error).message}`,
          );
          return {
            dispatched: 0,
            failed: 0,
            skipped: true,
            reason: 'DATABASE_UNAVAILABLE' as const,
          };
        }

        if (pendingRows.length === 0) {
          return { dispatched: 0, failed: 0, skipped: false };
        }

        let dispatched = 0;
        let failed = 0;

        // Publica por un canal RabbitMQ en secuencia. amqplib no admite varias
        // operaciones concurrentes sobre el mismo canal confirmable; los
        // confirms siguen acotados por mensaje y los locks por el timeout.
        const outcomes: Array<{
          row: OutboxEntity;
          messageId: string;
          error?: Error;
        }> = [];
        for (const row of pendingRows) {
          let messageId = row.event_id;
          try {
            const payload =
              typeof row.payload === 'string'
                ? JSON.parse(row.payload)
                : row.payload;
            const exchange =
              payload.kind === 'result' ? 'po.resultados.x' : 'po.eventos.x';
            const routingKey = row.event_type;
            const content = Buffer.from(JSON.stringify(payload));
            // Preservar exactamente el message_id de negocio en cada reintento.
            messageId = payload.message_id || row.event_id;
            returnedMessageIds.delete(messageId);

            if (this.customPublisher) {
              const publishedOk = await deadline(
                this.customPublisher.publish(exchange, routingKey, content, {
                  messageId,
                  correlationId:
                    payload.correlation_id || row.correlation_id || undefined,
                  contentType: 'application/json',
                  mandatory: true,
                  persistent: true,
                }),
                PUBLISH_CONFIRM_TIMEOUT_MS,
              );
              if (!publishedOk) {
                throw new Error(
                  `El publicador devolvió false (no confirmado) para mensaje ${messageId}`,
                );
              }
            } else if (confirmChannel) {
              await new Promise<void>((resolve, reject) => {
                let settled = false;
                const timeout = setTimeout(() => {
                  settled = true;
                  void (confirmChannel as amqp.ConfirmChannel)
                    .close()
                    .catch(() => undefined);
                  reject(
                    new Error(
                      `Timeout esperando publisher confirm (${messageId})`,
                    ),
                  );
                }, PUBLISH_CONFIRM_TIMEOUT_MS);
                try {
                  (confirmChannel as amqp.ConfirmChannel).publish(
                    exchange,
                    routingKey,
                    content,
                    {
                      messageId,
                      correlationId:
                        payload.correlation_id ||
                        row.correlation_id ||
                        undefined,
                      contentType: 'application/json',
                      mandatory: true,
                      persistent: true,
                    },
                    (err) => {
                      if (settled) return;
                      settled = true;
                      clearTimeout(timeout);
                      if (err) {
                        reject(err);
                      } else if (returnedMessageIds.has(messageId)) {
                        reject(
                          new Error(
                            `Mensaje ${messageId} devuelto por el broker: sin cola enlazada (basic.return)`,
                          ),
                        );
                      } else {
                        resolve();
                      }
                    },
                  );
                } catch (publishError) {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(publishError);
                  }
                }
              });
            }
            outcomes.push({ row, messageId });
          } catch (pubErr) {
            outcomes.push({ row, messageId, error: pubErr as Error });
          }
        }

        for (const [index, outcome] of outcomes.entries()) {
          if (outcome.error) {
            failed++;
            this.logger.error(
              `Fallo al publicar evento outbox ${outcome.row.id} (${outcome.row.event_type}): ${outcome.error.message}. Se conserva PENDING.`,
            );
            continue;
          }
          try {
            // Marcar PUBLISHED sólo después de confirm y ausencia de basic.return.
            const savepoint = `outbox_mark_${index}`;
            await txClient.query(`SAVEPOINT ${savepoint}`);
            await this.outboxRepository.markAsPublished(
              outcome.row.id,
              txClient,
            );
            await txClient.query(`RELEASE SAVEPOINT ${savepoint}`);
            dispatched++;
          } catch (markErr) {
            // PostgreSQL aborta la transacción tras cualquier error SQL. El
            // savepoint permite conservar el lote restante y dejar PENDING
            // únicamente el evento cuyo marcado falló.
            try {
              await txClient.query(
                `ROLLBACK TO SAVEPOINT outbox_mark_${index}`,
              );
              await txClient.query(`RELEASE SAVEPOINT outbox_mark_${index}`);
            } catch (rollbackErr) {
              throw new Error(
                `No fue posible recuperar la transacción Outbox tras fallar el marcado: ${(rollbackErr as Error).message}`,
                { cause: markErr },
              );
            }
            failed++;
            this.logger.error(
              `Fallo al persistir PUBLISHED para evento outbox ${outcome.row.id}: ${(markErr as Error).message}. Se conserva PENDING.`,
            );
          }
        }

        return { dispatched, failed, skipped: false };
      });
    } catch (connErr) {
      this.logger.warn(
        `Fallo de conexión RabbitMQ en OutboxPublisherService: ${(connErr as Error).message}. Frontera aislada sin afectar la persistencia interna.`,
      );
      return {
        dispatched: 0,
        failed: 0,
        skipped: true,
        reason: 'DEPENDENCY_UNAVAILABLE',
      };
    } finally {
      if (confirmChannel) {
        try {
          await deadline(confirmChannel.close(), 3000);
        } catch {
          // Ignorar error al cerrar canal
        }
      }
      if (amqpConn) {
        try {
          await deadline(amqpConn.close(), 3000);
        } catch {
          // Ignorar error al cerrar conexión
        }
      }
    }
  }
}
