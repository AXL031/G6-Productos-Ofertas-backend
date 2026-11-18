/**
 * Relay de Outbox → Azure Service Bus para inventory-svc (H5).
 *
 * Publica mensajes point-to-point a las colas autorizadas:
 *   g6.catalog.from.inventory   → initialization completed/rejected
 *   g6.combos.from.inventory    → stock.changed
 *   g6.promotions.from.inventory → stock.changed
 *
 * Patrón idéntico al pricing-svc: claim → send → finish.
 * Si la conexión no existe o falla, los mensajes quedan PENDING en outbox.
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
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import { DatabaseService } from '../database/database.service.js';
import {
  InventoryDeliveryStore,
  INVENTORY_QUEUES,
} from './service-bus-deliveries.js';
import { readInventoryServiceBus } from './service-bus-config.js';

const APPROVED_DESTINATIONS = new Set(Object.values(INVENTORY_QUEUES));

function inventoryEnvelope(row: {
  event_id: string;
  event_type: string;
  correlation_id?: string | null;
  payload: any;
}): Buffer {
  const payload =
    typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export class InventoryServiceBusRelay {
  constructor(
    private readonly store: Pick<InventoryDeliveryStore, 'claim' | 'finish'>,
    private readonly senders: ReadonlyMap<
      string,
      Pick<ServiceBusSender, 'createMessageBatch' | 'sendMessages'>
    >,
  ) {}

  async publishOne(): Promise<'empty' | 'sent' | 'pending' | 'lease-lost'> {
    const claim = await this.store.claim();
    if (!claim) return 'empty';
    let confirmed = false;
    try {
      if (!APPROVED_DESTINATIONS.has(claim.destination as any))
        throw new Error('INVENTORY_SERVICE_BUS_ROUTE_NOT_APPROVED');
      const sender = this.senders.get(claim.destination);
      if (!sender)
        throw new Error('INVENTORY_SERVICE_BUS_SENDER_NOT_AVAILABLE');
      const body = inventoryEnvelope(claim.row);
      const batch = await sender.createMessageBatch({
        maxSizeInBytes: 256 * 1024,
      });
      const payload =
        typeof claim.row.payload === 'string'
          ? JSON.parse(claim.row.payload)
          : claim.row.payload;
      if (
        !batch.tryAddMessage({
          body,
          messageId: claim.row.event_id,
          correlationId: claim.row.correlation_id ?? undefined,
          subject: claim.row.event_type,
          contentType: 'application/json',
          applicationProperties: {
            producer: 'inventory-svc',
            schema_version: payload.schema_version ?? 2,
            route_version: 1,
          },
        })
      )
        throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
      await sender.sendMessages(batch, {
        abortSignal: AbortSignal.timeout(10_000),
      });
      confirmed = true;
    } catch {
      // Un timeout puede ocurrir después de que el broker aceptó el batch.
    }
    const updated = await this.store.finish(claim, confirmed);
    return !updated ? 'lease-lost' : confirmed ? 'sent' : 'pending';
  }
}

@Injectable()
export class InventoryServiceBusRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  available = false;
  private client?: ServiceBusClient;
  private senders = new Map<string, ServiceBusSender>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(InventoryServiceBusRuntime.name);

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    let config: ReturnType<typeof readInventoryServiceBus>;
    try {
      config = readInventoryServiceBus(process.env);
    } catch {
      this.logger.warn('INVENTORY_SERVICE_BUS_CONFIGURATION_REJECTED');
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
    for (const queue of Object.values(INVENTORY_QUEUES)) {
      this.senders.set(queue, this.client.createSender(queue));
    }
    const relay = new InventoryServiceBusRelay(
      new InventoryDeliveryStore(this.database),
      this.senders,
    );
    const tick = () => {
      this.active = (async () => {
        // Probe: establecer el enlace y verificar autorización.
        const probe = this.senders.get(INVENTORY_QUEUES.CATALOG);
        if (probe) {
          await probe.createMessageBatch({ maxSizeInBytes: 256 * 1024 });
        }
        const result = await relay.publishOne();
        this.available = result === 'empty' || result === 'sent';
      })()
        .catch(() => {
          this.available = false;
        })
        .finally(() => {
          if (!this.available)
            this.logger.warn('SERVICE_BUS_INVENTORY_PENDING');
          if (!this.stopped) this.timer = setTimeout(tick, 1000);
        });
    };
    tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
    this.available = false;
    try {
      await Promise.allSettled(
        Array.from(this.senders.values()).map((s) => s.close()),
      );
    } finally {
      await this.client?.close();
    }
  }
}
