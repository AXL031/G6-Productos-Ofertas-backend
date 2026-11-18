/**
 * Relay de Outbox → Azure Service Bus para inventory-svc (H5).
 *
 * Publica mensajes point-to-point a las colas autorizadas:
 *   R11: g6.catalog.from.inventory   → inventory.sku.initialization.completed / rejected
 *   R12: g6.combos.from.inventory    → inventory.stock.changed
 *   R13: g6.promotions.from.inventory → inventory.stock.changed
 *
 * Exige contrato estricto de envelope:
 *   - payload.message_id válido (UUID) como messageId del broker (sin fallback a event_id).
 *   - payload.name === row.event_type
 *   - payload.producer === 'inventory-svc'
 *   - claim.destination coincidente con la ruta aprobada para el evento.
 * Ante violación contractual, registra fallo terminal 'terminal_invalid_envelope'
 * con last_error='INVALID_OUTBOX_CONTRACT' y next_attempt_at='infinity', conservando
 * la fila sin marcarla como enviada.
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
import { loadInventoryConfig } from '../config/inventory.config.js';
import {
  InventoryDeliveryStore,
  INVENTORY_QUEUES,
  APPROVED_ROUTES,
} from './service-bus-deliveries.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  async publishOne(): Promise<
    'empty' | 'sent' | 'pending' | 'lease-lost' | 'terminal-failure'
  > {
    const claim = await this.store.claim();
    if (!claim) return 'empty';

    try {
      const payload =
        typeof claim.row.payload === 'string'
          ? JSON.parse(claim.row.payload)
          : claim.row.payload;

      // Validación estricta del contrato del outbox
      const validMessageId =
        typeof payload?.message_id === 'string' &&
        UUID_REGEX.test(payload.message_id.trim());
      const validName = payload?.name === claim.row.event_type;
      const validProducer = payload?.producer === 'inventory-svc';
      const approvedDestinations = APPROVED_ROUTES.get(claim.row.event_type);
      const validDestination = Boolean(
        approvedDestinations &&
        approvedDestinations.includes(claim.destination as any),
      );

      if (
        !validMessageId ||
        !validName ||
        !validProducer ||
        !validDestination
      ) {
        // Fallo terminal contractual: libera el lease, last_error='INVALID_OUTBOX_CONTRACT',
        // next_attempt_at='infinity', sin marcar sent_at.
        const finished = await this.store.finish(
          claim,
          'terminal_invalid_envelope',
        );
        return finished ? 'terminal-failure' : 'lease-lost';
      }

      const sender = this.senders.get(claim.destination);
      if (!sender) {
        throw new Error('INVENTORY_SERVICE_BUS_SENDER_NOT_AVAILABLE');
      }

      const body = inventoryEnvelope(claim.row);
      const batch = await sender.createMessageBatch({
        maxSizeInBytes: 256 * 1024,
      });

      // El messageId enviado al broker debe ser exactamente payload.message_id (sin fallback a event_id)
      const contractualMessageId = payload.message_id;
      const correlationId =
        payload.correlation_id || claim.row.correlation_id || undefined;
      const operationId = payload.operation_id || undefined;
      const causationId = payload.causation_id || undefined;

      const added = batch.tryAddMessage({
        body,
        messageId: contractualMessageId,
        correlationId,
        subject: claim.row.event_type,
        contentType: 'application/json',
        applicationProperties: {
          producer: 'inventory-svc',
          schema_version: payload.schema_version ?? 2,
          route_version: 1,
          ...(operationId ? { operation_id: operationId } : {}),
          ...(causationId ? { causation_id: causationId } : {}),
        },
      });

      if (!added) {
        // Fallo terminal recuperable para mensajes que exceden 256 KB:
        // no reintentar en bucle infinito.
        const finished = await this.store.finish(claim, 'terminal_too_large');
        return finished ? 'terminal-failure' : 'lease-lost';
      }

      await sender.sendMessages(batch, {
        abortSignal: AbortSignal.timeout(10_000),
      });

      const updated = await this.store.finish(claim, 'confirmed');
      return !updated ? 'lease-lost' : 'sent';
    } catch {
      // Ante fallo transitorio de broker, conservar PENDING para reintento con backoff
      const updated = await this.store.finish(claim, 'failed');
      return !updated ? 'lease-lost' : 'pending';
    }
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
    const config = loadInventoryConfig();
    if (!config.serviceBus || !config.serviceBus.publishEnabled) return;

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

    for (const queue of Object.values(INVENTORY_QUEUES)) {
      this.senders.set(queue, this.client.createSender(queue));
    }

    const relay = new InventoryServiceBusRelay(
      new InventoryDeliveryStore(this.database),
      this.senders,
    );

    const tick = () => {
      this.active = (async () => {
        // Probe: verificar enlace con el broker
        const probe = this.senders.get(INVENTORY_QUEUES.CATALOG);
        if (probe) {
          await probe.createMessageBatch({ maxSizeInBytes: 256 * 1024 });
        }
        const result = await relay.publishOne();
        this.available =
          result === 'empty' ||
          result === 'sent' ||
          result === 'terminal-failure';
      })()
        .catch(() => {
          this.available = false;
        })
        .finally(() => {
          if (!this.available) {
            this.logger.warn('SERVICE_BUS_INVENTORY_PENDING');
          }
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
