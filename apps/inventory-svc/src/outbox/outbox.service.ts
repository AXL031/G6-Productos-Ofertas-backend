import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IDatabaseClient } from '../database/database.interface.js';
import { OUTBOX_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type { IOutboxRepository } from '../repositories/interfaces/outbox.repository.interface.js';
import { loadInventoryConfig } from '../config/inventory.config.js';

export interface OutboxRecord {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id?: string | null;
  payload: Record<string, unknown>;
}

export interface AsyncApiEnvelopeParams {
  eventName: string;
  kind: 'event' | 'result';
  operationId: string;
  causationId?: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(
    @Inject(OUTBOX_REPOSITORY)
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  /**
   * Constructs an AsyncAPI 0.6.0-rc.1 compliant envelope
   */
  createMessageEnvelope(
    params: AsyncApiEnvelopeParams,
  ): Record<string, unknown> {
    const messageId = randomUUID();
    const correlationId = params.correlationId || randomUUID();
    const causationId = params.causationId || params.operationId;

    return {
      message_id: messageId,
      schema_version: 2,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: causationId,
      operation_id: params.operationId,
      producer: 'inventory-svc',
      kind: params.kind,
      name: params.eventName,
      data: params.data,
    };
  }

  /**
   * Enqueues an event into inventory.outbox within the active database transaction
   */
  async enqueue(client: IDatabaseClient, record: OutboxRecord): Promise<void> {
    await this.outboxRepository.enqueue(client, record);
  }

  /** Snapshot autoritativo completo, persistido en la misma transacción que el saldo. */
  async stockChanged(
    client: IDatabaseClient,
    values: {
      sku: string;
      location_id: string;
      on_hand: number;
      reserved: number;
      blocked: number;
      stock_version: number;
      operationId: string;
      correlationId: string;
    },
  ): Promise<void> {
    const { rows } = await client.query<{
      sku_id: string | null;
      umbral_efectivo: number;
    }>(
      `SELECT sku_id, umbral_efectivo FROM inventory.stock_threshold_override
       WHERE location_id IS NULL AND (sku_id IS NULL OR sku_id = $1)`,
      [values.sku],
    );
    const global =
      rows.find((row) => row.sku_id === null)?.umbral_efectivo ??
      loadInventoryConfig().defaultLowStockThreshold;
    const threshold =
      rows.find((row) => row.sku_id === values.sku)?.umbral_efectivo ?? global;
    const available = Math.max(
      0,
      values.on_hand - values.reserved - values.blocked,
    );
    const payload = this.createMessageEnvelope({
      eventName: 'inventory.stock.changed',
      kind: 'event',
      operationId: values.operationId,
      correlationId: values.correlationId,
      data: {
        sku: values.sku,
        location_id: values.location_id,
        on_hand: values.on_hand,
        reserved: values.reserved,
        blocked: values.blocked,
        available,
        estado:
          available === 0
            ? 'AGOTADO'
            : available <= threshold
              ? 'STOCK_BAJO'
              : 'DISPONIBLE',
        stock_version: values.stock_version,
        updated_at: new Date().toISOString(),
      },
    });
    await this.enqueue(client, {
      event_id: randomUUID(),
      event_type: 'inventory.stock.changed',
      aggregate_type: 'stock',
      aggregate_id: values.sku,
      correlation_id: values.correlationId,
      payload,
    });
  }
}
