/**
 * Tabla outbox_delivery y store de entrega para Azure Service Bus (H5).
 *
 * Patrón idéntico al de pricing-svc: cada outbox row que debe ir a Service Bus
 * tiene una fila en outbox_delivery con destino, intento y lease.
 *
 * Destinos autorizados para inventory-svc:
 *   g6.catalog.from.inventory   → initialization completed/rejected
 *   g6.combos.from.inventory    → stock.changed
 *   g6.promotions.from.inventory → stock.changed
 */

import { randomUUID } from 'node:crypto';
import type { IDatabaseClient } from '../database/database.interface.js';
import type { OutboxEntity } from '../repositories/interfaces/outbox.repository.interface.js';
import { readInventoryServiceBus } from './service-bus-config.js';

// Colas H5 point-to-point (Basic tier — sin topics/subscriptions).
export const INVENTORY_QUEUES = {
  CATALOG: 'g6.catalog.from.inventory',
  COMBOS: 'g6.combos.from.inventory',
  PROMOTIONS: 'g6.promotions.from.inventory',
  BULK: 'g6.bulk.from.inventory',
} as const;

export type InventoryQueue =
  (typeof INVENTORY_QUEUES)[keyof typeof INVENTORY_QUEUES];

const APPROVED_ROUTES: ReadonlyMap<string, readonly InventoryQueue[]> = new Map([
  [
    'inventory.sku.initialization.completed',
    [INVENTORY_QUEUES.CATALOG],
  ],
  [
    'inventory.sku.initialization.rejected',
    [INVENTORY_QUEUES.CATALOG],
  ],
  [
    'inventory.stock.changed',
    [INVENTORY_QUEUES.COMBOS, INVENTORY_QUEUES.PROMOTIONS],
  ],
]);

export interface InventoryDeliveryClaim {
  token: string;
  destination: string;
  row: OutboxEntity;
}

/**
 * Registra las entregas pendientes para un outbox row (mismo tx que el negocio).
 */
export async function insertInventoryDeliveries(
  client: IDatabaseClient,
  row: { event_id: string; event_type: string },
): Promise<void> {
  let sbConfig: ReturnType<typeof readInventoryServiceBus>;
  try {
    sbConfig = readInventoryServiceBus(process.env);
  } catch {
    sbConfig = undefined;
  }
  if (!sbConfig) return;

  const destinations = APPROVED_ROUTES.get(row.event_type);
  if (!destinations || destinations.length === 0) return;
  for (const destination of destinations) {
    await client.query(
      `INSERT INTO inventory.outbox_delivery
         (message_id, destination, route_version, transport, created_at, next_attempt_at, attempts)
       VALUES ($1, $2, 1, 'AZURE_SERVICE_BUS', now(), now(), 0)
       ON CONFLICT (message_id, destination) DO NOTHING`,
      [row.event_id, destination],
    );
  }
}

/**
 * Store transaccional para reclamar y confirmar entregas.
 */
export class InventoryDeliveryStore {
  constructor(
    private readonly txRunner: {
      transaction<T>(fn: (client: IDatabaseClient) => Promise<T>): Promise<T>;
    },
  ) {}

  async claim(): Promise<InventoryDeliveryClaim | undefined> {
    return this.txRunner.transaction(async (client) => {
      const { rows } = await client.query<{
        message_id: string;
        destination: string;
        route_version: number;
        transport: string;
      }>(
        `SELECT message_id, destination, route_version, transport
         FROM inventory.outbox_delivery
         WHERE sent_at IS NULL
           AND next_attempt_at <= clock_timestamp()
           AND (lease_until IS NULL OR lease_until <= clock_timestamp())
         ORDER BY next_attempt_at ASC, created_at ASC, message_id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const candidate = rows[0];
      if (!candidate) return undefined;

      if (
        candidate.route_version !== 1 ||
        candidate.transport !== 'AZURE_SERVICE_BUS'
      )
        throw new Error('INVENTORY_SERVICE_BUS_ROUTE_NOT_APPROVED');

      // Leer el row de outbox correspondiente.
      const outboxResult = await client.query<OutboxEntity>(
        `SELECT id, event_id, event_type, aggregate_type, aggregate_id,
                correlation_id, payload, status, created_at
         FROM inventory.outbox
         WHERE event_id = $1`,
        [candidate.message_id],
      );
      const row = outboxResult.rows[0];
      if (!row)
        throw new Error('INVENTORY_SERVICE_BUS_FACT_MISSING');

      // Normalizar payload
      if (typeof row.payload === 'string') {
        row.payload = JSON.parse(row.payload);
      }

      const token = randomUUID();
      await client.query(
        `UPDATE inventory.outbox_delivery
         SET lease_token = $1,
             lease_until = clock_timestamp() + interval '30 seconds',
             attempts = attempts + 1
         WHERE message_id = $2 AND destination = $3`,
        [token, candidate.message_id, candidate.destination],
      );
      return { row, token, destination: candidate.destination };
    });
  }

  async finish(
    claim: InventoryDeliveryClaim,
    confirmed: boolean,
  ): Promise<boolean> {
    return this.txRunner.transaction(async (client) => {
      const { rows } = await client.query<{ message_id: string }>(
        `UPDATE inventory.outbox_delivery
         SET lease_token = NULL,
             lease_until = NULL,
             sent_at = CASE WHEN $1 THEN clock_timestamp() ELSE NULL END,
             last_error = CASE WHEN $1 THEN NULL ELSE 'SEND_NOT_CONFIRMED' END,
             next_attempt_at = CASE WHEN $1
               THEN clock_timestamp()
               ELSE clock_timestamp() + make_interval(secs => least(60, power(2, least(attempts, 6))::int))
             END
         WHERE message_id = $2
           AND destination = $3
           AND lease_token = $4
           AND lease_until > clock_timestamp()
           AND sent_at IS NULL
         RETURNING message_id`,
        [confirmed, claim.row.event_id, claim.destination, claim.token],
      );
      return rows.length === 1;
    });
  }
}
