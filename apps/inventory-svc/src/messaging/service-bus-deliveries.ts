/**
 * Tabla outbox_delivery y store de entrega para Azure Service Bus (H5).
 *
 * Registra las entregas punto a punto en inventory.outbox_delivery dentro
 * de la misma transacción en que se inserta el evento en inventory.outbox.
 *
 * Destinos aprobados (G6 Basic):
 *   R11: g6.catalog.from.inventory   → inventory.sku.initialization.completed / rejected
 *   R12: g6.combos.from.inventory    → inventory.stock.changed
 *   R13: g6.promotions.from.inventory → inventory.stock.changed
 */

import { randomUUID } from 'node:crypto';
import type { IDatabaseClient } from '../database/database.interface.js';
import type { OutboxEntity } from '../repositories/interfaces/outbox.repository.interface.js';

export const INVENTORY_QUEUES = {
  CATALOG: 'g6.catalog.from.inventory',
  COMBOS: 'g6.combos.from.inventory',
  PROMOTIONS: 'g6.promotions.from.inventory',
} as const;

export type InventoryQueue =
  (typeof INVENTORY_QUEUES)[keyof typeof INVENTORY_QUEUES];

const APPROVED_ROUTES: ReadonlyMap<string, readonly InventoryQueue[]> = new Map(
  [
    ['inventory.sku.initialization.completed', [INVENTORY_QUEUES.CATALOG]],
    ['inventory.sku.initialization.rejected', [INVENTORY_QUEUES.CATALOG]],
    [
      'inventory.stock.changed',
      [INVENTORY_QUEUES.COMBOS, INVENTORY_QUEUES.PROMOTIONS],
    ],
  ],
);

export interface InventoryDeliveryClaim {
  token: string;
  destination: string;
  row: OutboxEntity;
}

export type DeliveryOutcome = 'confirmed' | 'failed' | 'terminal_too_large';

/**
 * Registra las entregas pendientes para un outbox row en la misma transacción de DB.
 * Con H5 seleccionado (MESSAGING_PROVIDER=AZURE_SERVICE_BUS), registra las entregas
 * aprobadas incluso si el relay worker está pausado por configuración.
 */
export async function insertInventoryDeliveries(
  client: IDatabaseClient,
  row: { event_id: string; event_type: string },
): Promise<void> {
  if (process.env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS') return;

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
 * Store transaccional para reclamar y confirmar entregas con FOR UPDATE SKIP LOCKED y leases.
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
      if (!row) throw new Error('INVENTORY_SERVICE_BUS_FACT_MISSING');

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
    outcome: DeliveryOutcome | boolean,
  ): Promise<boolean> {
    const status: DeliveryOutcome =
      typeof outcome === 'boolean'
        ? outcome
          ? 'confirmed'
          : 'failed'
        : outcome;

    return this.txRunner.transaction(async (client) => {
      const isConfirmed = status === 'confirmed';
      const isTooLarge = status === 'terminal_too_large';

      const lastError = isConfirmed
        ? null
        : isTooLarge
          ? 'MESSAGE_EXCEEDS_256KB'
          : 'SEND_NOT_CONFIRMED';

      const nextAttemptSql = isConfirmed
        ? `clock_timestamp()`
        : isTooLarge
          ? `'infinity'::timestamptz`
          : `clock_timestamp() + make_interval(secs => least(60, power(2, least(attempts, 6))::int))`;

      const { rows } = await client.query<{ message_id: string }>(
        `UPDATE inventory.outbox_delivery
         SET lease_token = NULL,
             lease_until = NULL,
             sent_at = CASE WHEN $1 THEN clock_timestamp() ELSE NULL END,
             last_error = $2,
             next_attempt_at = ${nextAttemptSql}
         WHERE message_id = $3
           AND destination = $4
           AND lease_token = $5
           AND lease_until > clock_timestamp()
           AND sent_at IS NULL
         RETURNING message_id`,
        [
          isConfirmed,
          lastError,
          claim.row.event_id,
          claim.destination,
          claim.token,
        ],
      );
      return rows.length === 1;
    });
  }
}
