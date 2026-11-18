/**
 * Consumer de Azure Service Bus para inventory-svc (H5).
 *
 * Escucha en modo PeekLock las colas:
 *   g6.inventory.from.catalog → initialization.requested, catalog.sku.deactivated
 *   g6.inventory.from.bulk    → bulk.stock.adjust.requested (BLOCKED_CONTRACT)
 *
 * Los mensajes se procesan usando el InventoryCommandService existente
 * (misma lógica inbox/idempotencia), completando el mensaje del broker
 * sólo tras el commit de la transacción DB.
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
import { InventoryCommandService } from '../inbox/inventory-command.service.js';
import { readInventoryServiceBus } from './service-bus-config.js';

const QUEUE_CATALOG = 'g6.inventory.from.catalog';
const QUEUE_BULK = 'g6.inventory.from.bulk';

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
      )
        throw new Error('INVALID_ENVELOPE');

      payload = JSON.parse(content.toString('utf8'));

      // Validar que el mensaje es uno de los aceptados.
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('name' in payload) ||
        typeof (payload as Record<string, unknown>).name !== 'string'
      )
        throw new Error('INVALID_ENVELOPE');

      const eventName = (payload as Record<string, unknown>).name as string;

      // Bloqueo explícito para bulk.
      if (eventName === 'inventory.bulk.stock.adjust.requested') {
        // BLOCKED_CONTRACT: el InventoryCommandService lo rechaza,
        // pero lo tratamos aquí para DLQ explícito.
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: 'BLOCKED_CONTRACT',
          deadLetterErrorDescription:
            'inventory.bulk.stock.adjust.requested está bloqueado por contrato pendiente.',
        });
        return 'dead-lettered';
      }

      if (!ACCEPTED_EVENTS.has(eventName))
        throw new Error('UNKNOWN_EVENT_TYPE');
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
      // InventoryMessageError con reason INVALID_MESSAGE o FEATURE_DISABLED → DLQ.
      if (
        error &&
        typeof error === 'object' &&
        'reason' in error &&
        ((error as any).reason === 'INVALID_MESSAGE' ||
          (error as any).reason === 'BLOCKED_CONTRACT')
      ) {
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: (error as any).reason,
          deadLetterErrorDescription: String(error),
        });
        return 'dead-lettered';
      }
      // Error transitorio (DB, red): abandonar para reintento.
      await this.receiver.abandonMessage(message);
      return 'abandoned';
    }
    // Completar sólo después del commit de la transacción.
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
  private receivers: ServiceBusReceiver[] = [];
  private subscriptions: Array<{ close(): Promise<void> }> = [];
  private openings: Promise<void>[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly logger = new Logger(InventoryServiceBusConsumerRuntime.name);

  constructor(private readonly commands: InventoryCommandService) {}

  onApplicationBootstrap(): void {
    let config: ReturnType<typeof readInventoryServiceBus>;
    try {
      config = readInventoryServiceBus(process.env);
    } catch {
      this.logger.warn('INVENTORY_SERVICE_BUS_CONSUMER_CONFIGURATION_REJECTED');
      return;
    }
    if (!config) return;

    this.client = new ServiceBusClient(
      config.namespace,
      config.managedIdentityClientId
        ? new ManagedIdentityCredential({
            clientId: config.managedIdentityClientId,
          })
        : new DefaultAzureCredential(),
      {
        retryOptions: { maxRetries: 0, timeoutInMs: 5000 },
      },
    );

    // Cola principal: catalog → inventory.
    this.startReceiver(QUEUE_CATALOG);
    // Cola bulk: bloqueada por contrato, pero escuchamos para DLQ explícito.
    this.startReceiver(QUEUE_BULK);
  }

  private startReceiver(queue: string): void {
    if (!this.client) return;
    const receiver = this.client.createReceiver(queue, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
      maxAutoLockRenewalDurationInMs: 60_000,
    });
    this.receivers.push(receiver);
    const handler = new InventoryServiceBusHandler(this.commands, receiver);

    const open = () => {
      const opening = receiver
        .peekMessages(1)
        .then(() => {
          if (this.stopped) return;
          const sub = receiver.subscribe(
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
                  `SERVICE_BUS_INVENTORY_CONSUMER_RECOVERY_PENDING [${queue}]`,
                );
                if (!this.stopped)
                  this.timers.push(setTimeout(open, 2000));
              },
            },
            { autoCompleteMessages: false, maxConcurrentCalls: 1 },
          );
          this.subscriptions.push(sub);
          this.available = true;
        })
        .catch(() => {
          this.available = false;
          if (!this.stopped) this.timers.push(setTimeout(open, 2000));
        });
      this.openings.push(opening);
    };
    open();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    await Promise.allSettled(this.openings);
    try {
      await Promise.allSettled(this.subscriptions.map((s) => s.close()));
      await Promise.allSettled(this.active);
    } finally {
      this.available = false;
      try {
        await Promise.allSettled(this.receivers.map((r) => r.close()));
      } finally {
        await this.client?.close();
      }
    }
  }
}
