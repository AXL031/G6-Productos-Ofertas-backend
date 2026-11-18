/**
 * Consumer de Azure Service Bus para inventory-svc (H5).
 *
 * Flujo R06: Escucha en modo PeekLock la cola g6.inventory.from.catalog:
 *   - inventory.sku.initialization.requested
 *   - catalog.sku.deactivated (respetando flag INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED)
 *
 * Los mensajes se procesan usando InventoryCommandService con persistencia
 * transaccional e idempotencia en inbox.
 * Liquidación:
 *   - completeMessage: únicamente tras el commit durable en DB.
 *   - abandonMessage: ante fallos transitorios (DB, red) para reintento con backoff.
 *   - deadLetterMessage: para INVALID_MESSAGE, envelope corrupto, BLOCKED_CONTRACT
 *     o FEATURE_DISABLED (este último sin reintentos infinitos).
 *
 * R02 / Bulk permanece BLOCKED_CONTRACT: no se habilita su receptor.
 */

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceiver,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import {
  InventoryCommandService,
  InventoryMessageError,
} from '../inbox/inventory-command.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';

export const QUEUE_CATALOG = 'g6.inventory.from.catalog';

const ACCEPTED_EVENTS = new Set([
  'inventory.sku.initialization.requested',
  'catalog.sku.deactivated',
]);

export type InventoryBusSettlement = Pick<
  ServiceBusReceiver,
  'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
>;

export class InventoryServiceBusHandler {
  constructor(
    private readonly commands: InventoryCommandService,
    private readonly receiver: InventoryBusSettlement,
  ) {}

  async handle(
    message: ServiceBusReceivedMessage,
  ): Promise<'completed' | 'abandoned' | 'dead-lettered'> {
    let payload: unknown;
    try {
      const body: unknown = message.body;
      const content =
        typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : body instanceof Uint8Array
            ? body
            : typeof body === 'object' && body !== null
              ? Buffer.from(JSON.stringify(body), 'utf8')
              : undefined;

      if (
        !content ||
        content.byteLength > 256 * 1024 ||
        typeof message.messageId !== 'string'
      ) {
        throw new Error('INVALID_ENVELOPE');
      }

      payload = JSON.parse(content.toString('utf8'));

      if (
        !payload ||
        typeof payload !== 'object' ||
        !('name' in payload) ||
        typeof (payload as Record<string, unknown>).name !== 'string'
      ) {
        throw new Error('INVALID_ENVELOPE');
      }

      const p = payload as Record<string, unknown>;
      const eventName = p.name as string;

      // Validación estricta: correspondencia entre subject del mensaje y name del envelope
      if (
        typeof message.subject === 'string' &&
        message.subject !== eventName
      ) {
        throw new Error('SUBJECT_MISMATCH');
      }

      // Validación de identidad: messageId del broker debe coincidir con payload.message_id
      if (
        typeof p.message_id === 'string' &&
        message.messageId !== p.message_id
      ) {
        throw new Error('MESSAGE_ID_MISMATCH');
      }

      // Validación de emisor legítimo para R06
      if (p.producer !== 'catalog-svc') {
        throw new Error('PRODUCER_MISMATCH');
      }

      // Bloqueo estricto para operaciones de Bulk (R02)
      if (eventName === 'inventory.bulk.stock.adjust.requested') {
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: 'BLOCKED_CONTRACT',
          deadLetterErrorDescription:
            'inventory.bulk.stock.adjust.requested está bloqueado por contrato pendiente (R02).',
        });
        return 'dead-lettered';
      }

      if (!ACCEPTED_EVENTS.has(eventName)) {
        throw new Error('UNKNOWN_EVENT_TYPE');
      }
    } catch {
      await this.receiver.deadLetterMessage(message, {
        deadLetterReason: 'INVALID_INVENTORY_CONTRACT',
        deadLetterErrorDescription:
          'El envelope o payload no cumple el contrato aprobado de Inventory.',
      });
      return 'dead-lettered';
    }

    try {
      await this.commands.process(payload);
    } catch (error) {
      if (error instanceof InventoryMessageError) {
        // INVALID_MESSAGE, BLOCKED_CONTRACT o FEATURE_DISABLED van a DLQ
        // FEATURE_DISABLED no debe provocar un bucle de reintentos
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: error.reason,
          deadLetterErrorDescription: `Rechazado por InventoryCommandService: ${error.reason}`,
        });
        return 'dead-lettered';
      }

      // Error transitorio (DB, deadlock, red): abandonar mensaje para reintento con backoff
      await this.receiver.abandonMessage(message);
      return 'abandoned';
    }

    // Completar únicamente tras persistencia y commit exitoso
    await this.receiver.completeMessage(message);
    return 'completed';
  }
}

@Injectable()
export class InventoryServiceBusConsumerRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  available = false;
  private client?: ServiceBusClient;
  private receiver?: ServiceBusReceiver;
  private subscription?: { close(): Promise<void> };
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private isOpening = false;
  private stopped = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly logger = new Logger(InventoryServiceBusConsumerRuntime.name);

  constructor(private readonly commands: InventoryCommandService) {}

  onApplicationBootstrap(): void {
    const config = loadInventoryConfig();
    if (!config.serviceBus || !config.serviceBus.consumeEnabled) return;

    this.client = new ServiceBusClient(
      config.serviceBus.namespace,
      config.serviceBus.managedIdentityClientId
        ? new ManagedIdentityCredential({
            clientId: config.serviceBus.managedIdentityClientId,
          })
        : new DefaultAzureCredential(),
      {
        retryOptions: { maxRetries: 0, timeoutInMs: 5000 },
      },
    );

    // Solo se suscribe al flujo R06 (Catalog → Inventory); Bulk (R02) permanece bloqueado.
    void this.open();
  }

  private async open(): Promise<void> {
    if (this.stopped || this.isOpening || !this.client) return;
    this.isOpening = true;

    try {
      // Garantizar que no existan suscripciones previas duplicadas
      if (this.subscription) {
        await this.subscription.close().catch(() => undefined);
        this.subscription = undefined;
      }

      this.receiver ??= this.client.createReceiver(QUEUE_CATALOG, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
        maxAutoLockRenewalDurationInMs: 60_000,
      });

      await this.receiver.peekMessages(1);
      if (this.stopped) return;

      const handler = new InventoryServiceBusHandler(
        this.commands,
        this.receiver,
      );

      this.subscription = this.receiver.subscribe(
        {
          processMessage: async (msg) => {
            const task = handler.handle(msg);
            this.active.add(task);
            try {
              await task;
              this.available = true;
            } catch (error) {
              this.available = false;
              throw error;
            } finally {
              this.active.delete(task);
            }
          },
          processError: async () => {
            this.available = false;
            this.logger.warn(
              `SERVICE_BUS_INVENTORY_CONSUMER_RECOVERY_PENDING [${QUEUE_CATALOG}]`,
            );
            if (!this.stopped && !this.reconnectTimer) {
              this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = undefined;
                void this.open();
              }, 2000);
            }
          },
        },
        { autoCompleteMessages: false, maxConcurrentCalls: 1 },
      );

      this.available = true;
    } catch {
      this.available = false;
      if (!this.stopped && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.open();
        }, 2000);
      }
    } finally {
      this.isOpening = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      if (this.subscription) {
        await this.subscription.close().catch(() => undefined);
        this.subscription = undefined;
      }
      await Promise.allSettled(this.active);
    } finally {
      this.available = false;
      try {
        await this.receiver?.close().catch(() => undefined);
      } finally {
        await this.client?.close().catch(() => undefined);
      }
    }
  }
}
