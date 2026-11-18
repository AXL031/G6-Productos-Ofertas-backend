/**
 * Consumidor punto a punto Azure Service Bus para inventory-svc (H5).
 *
 * Flujo R06:
 *   Cola: g6.inventory.from.catalog
 *   Eventos autorizados:
 *     - inventory.sku.initialization.requested
 *     - catalog.sku.deactivated (respetando CATALOG_SKU_DEACTIVATION_ENABLED)
 *
 * Flujo R02 / Bulk:
 *   Bloqueado por contrato (BLOCKED_CONTRACT). No se suscribe receptor para Bulk.
 *
 * Idempotencia y durabilidad:
 *   - Modo PeekLock.
 *   - Validación estricta de envelope (subject === payload.name, messageId === payload.message_id como UUIDs válidos, producer === 'catalog-svc').
 *   - DLQ inmediato para violaciones de contrato, INVALID_MESSAGE y FEATURE_DISABLED.
 *   - Errores transitorios aplican retardo exponencial (1, 2, 4, 8, hasta 16s según deliveryCount) antes de abandonMessage.
 *   - Commit durable antes de completeMessage.
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
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InventoryBusSettlement = Pick<
  ServiceBusReceiver,
  'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
>;

export type DelayFn = (ms: number) => Promise<void>;
const defaultDelay: DelayFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function computeTransientBackoffMs(deliveryCount?: number): number {
  const count =
    typeof deliveryCount === 'number' && deliveryCount > 0 ? deliveryCount : 1;
  const exp = Math.min(count - 1, 4);
  const seconds = Math.min(16, Math.pow(2, exp));
  return seconds * 1000;
}

export class InventoryServiceBusHandler {
  constructor(
    private readonly commands: Pick<InventoryCommandService, 'process'>,
    private readonly receiver: InventoryBusSettlement,
    private readonly delay: DelayFn = defaultDelay,
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

      if (!content || content.byteLength > 256 * 1024) {
        throw new Error('INVALID_ENVELOPE_CONTENT');
      }

      // Validar message.messageId como UUID válido
      if (
        typeof message.messageId !== 'string' ||
        !UUID_REGEX.test(message.messageId.trim())
      ) {
        throw new Error('INVALID_BROKER_MESSAGE_ID');
      }

      // Validar message.subject existente y no vacío
      if (
        typeof message.subject !== 'string' ||
        message.subject.trim().length === 0
      ) {
        throw new Error('INVALID_BROKER_SUBJECT');
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

      // Validación estricta: correspondencia exacta entre subject del mensaje y name del envelope
      if (message.subject !== eventName) {
        throw new Error('SUBJECT_MISMATCH');
      }

      // Validación de payload.message_id como UUID válido y coincidencia exacta con message.messageId
      if (
        typeof p.message_id !== 'string' ||
        !UUID_REGEX.test(p.message_id.trim()) ||
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
        // INVALID_MESSAGE, BLOCKED_CONTRACT o FEATURE_DISABLED van a DLQ de inmediato sin bucle de reintentos
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: error.reason,
          deadLetterErrorDescription: `Rechazado por InventoryCommandService: ${error.reason}`,
        });
        return 'dead-lettered';
      }

      // Error transitorio (DB, deadlock, red): aplicar retardo de 1, 2, 4, 8 hasta 16s según deliveryCount antes de abandonMessage
      const delayMs = computeTransientBackoffMs(message.deliveryCount);
      await this.delay(delayMs);
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
      // Cierra la suscripción anterior antes de crear la siguiente.
      // Si falla el cierre, no crea otra suscripción sobre el receiver anterior:
      // cierra ese receiver y reintenta la recuperación.
      if (this.subscription) {
        try {
          await this.subscription.close();
        } catch (closeErr) {
          this.subscription = undefined;
          if (this.receiver) {
            await this.receiver.close().catch(() => undefined);
            this.receiver = undefined;
          }
          throw closeErr;
        }
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
            this.scheduleReconnect();
          },
        },
        { autoCompleteMessages: false, maxConcurrentCalls: 1 },
      );

      this.available = true;
    } catch {
      this.available = false;
      this.scheduleReconnect();
    } finally {
      this.isOpening = false;
    }
  }

  private scheduleReconnect(): void {
    if (!this.stopped && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.open();
      }, 2000);
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
        this.receiver = undefined;
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
      }
    }
  }
}
