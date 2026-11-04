import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  INBOX_REPOSITORY,
  LOCATIONS_REPOSITORY,
  OPERATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IInboxRepository } from '../repositories/interfaces/inbox.repository.interface.js';
import type { ILocationsRepository } from '../repositories/interfaces/locations.repository.interface.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';
import type { IDatabaseClient } from '../database/database.interface.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INITIALIZATION = 'inventory.sku.initialization.requested';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export class InventoryMessageError extends Error {
  constructor(public readonly reason: 'INVALID_MESSAGE' | 'BLOCKED_CONTRACT') {
    super(reason);
  }
}
interface Initialization {
  message_id: string;
  operation_id: string;
  correlation_id: string;
  data: {
    sku: string;
    product_id: string;
    variant_id?: string | null;
    default_location_id?: string | null;
  };
}
interface InitializationResult {
  sku: string;
  product_id: string;
  variant_id: string | null;
  status: 'INITIALIZED' | 'REJECTED';
  code: string | null;
  completed_at: string;
}

@Injectable()
export class InventoryCommandService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    @Inject(INBOX_REPOSITORY) private readonly inbox: IInboxRepository,
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operations: IOperationsRepository,
    @Inject(LOCATIONS_REPOSITORY)
    private readonly locations: ILocationsRepository,
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stock: IStockBalanceRepository,
  ) {}

  async process(
    payload: unknown,
  ): Promise<{ duplicate: boolean; status?: InitializationResult['status'] }> {
    const message = this.validate(payload);
    const fingerprint = this.idempotency.computeFingerprint({
      name: INITIALIZATION,
      producer: 'catalog-svc',
      data: {
        sku: message.data.sku,
        product_id: message.data.product_id,
        variant_id: message.data.variant_id ?? null,
        default_location_id: message.data.default_location_id ?? null,
      },
    });
    return this.database.transaction(async (client) => {
      await this.operations.lockIdempotencyKey(
        client,
        `inbox:${message.message_id}`,
      );
      const delivery = await this.inbox.register(client, {
        message_id: message.message_id,
        message_type: INITIALIZATION,
        source: 'catalog-svc',
        payload,
      });
      if (
        this.idempotency.computeFingerprint(delivery.payload) !==
        this.idempotency.computeFingerprint(payload)
      ) {
        throw new InventoryMessageError('INVALID_MESSAGE');
      }
      if (delivery.status === 'PROCESSED') return { duplicate: true };
      await this.operations.lockIdempotencyKey(client, message.operation_id);
      const existing = await this.operations.findByOperationIdOrIdempotencyKey(
        message.operation_id,
        message.operation_id,
        client,
      );
      let result: InitializationResult;
      if (existing) {
        if (
          existing.operation_id !== message.operation_id ||
          existing.intention !== INITIALIZATION ||
          existing.client_id !== 'catalog-svc' ||
          existing.request_fingerprint !== fingerprint
        ) {
          result = this.result(message, 'REJECTED', 'IDEMPOTENCY_CONFLICT');
        } else {
          const previous: unknown =
            typeof existing.result_payload === 'string'
              ? JSON.parse(existing.result_payload)
              : existing.result_payload;
          if (
            !record(previous) ||
            !['INITIALIZED', 'REJECTED'].includes(String(previous.status)) ||
            previous.sku !== message.data.sku ||
            previous.product_id !== message.data.product_id ||
            previous.variant_id !== (message.data.variant_id ?? null) ||
            (previous.code !== null && typeof previous.code !== 'string') ||
            typeof previous.completed_at !== 'string' ||
            !Number.isFinite(Date.parse(previous.completed_at)) ||
            existing.status !==
              (previous.status === 'INITIALIZED' ? 'APLICADO' : 'RECHAZADO')
          ) {
            throw new Error(
              'Resultado durable de inicialización inconsistente',
            );
          }
          result = previous as unknown as InitializationResult;
        }
      } else {
        const active = await this.locations.findActive(client);
        const location =
          message.data.default_location_id ??
          (active.length === 1 ? active[0].id : null);
        if (
          !location ||
          !active.some((candidate) => candidate.id === location)
        ) {
          result = this.result(message, 'REJECTED', 'UBICACION_NO_ENCONTRADA');
        } else {
          const created = await this.stock.initializeZero(
            client,
            message.data.sku,
            location,
          );
          result = this.result(message, 'INITIALIZED', null);
          if (created)
            await this.outbox.stockChanged(client, {
              sku: message.data.sku,
              location_id: location,
              on_hand: 0,
              reserved: 0,
              blocked: 0,
              stock_version: 0,
              operationId: message.operation_id,
              correlationId: message.correlation_id,
            });
        }
        await this.operations.create(client, {
          operation_type: 'INICIALIZACION_SKU',
          idempotency_key: message.operation_id,
          operation_id: message.operation_id,
          intention: INITIALIZATION,
          client_id: 'catalog-svc',
          status: result.status === 'INITIALIZED' ? 'APLICADO' : 'RECHAZADO',
          result_code: result.code,
          request_fingerprint: fingerprint,
          request_payload: JSON.stringify(message.data),
          result_payload: JSON.stringify(result),
          correlation_id: message.correlation_id,
        });
      }
      await this.enqueueResult(client, message, result);
      await this.inbox.markProcessed(client, message.message_id);
      return { duplicate: false, status: result.status };
    });
  }

  private validate(payload: unknown): Initialization {
    if (!record(payload)) throw new InventoryMessageError('INVALID_MESSAGE');
    if (
      payload.name === 'inventory.bulk.stock.adjust.requested' ||
      payload.name === 'catalog.sku.deactivated'
    ) {
      throw new InventoryMessageError('BLOCKED_CONTRACT');
    }
    if (
      payload.name !== INITIALIZATION ||
      payload.kind !== 'command' ||
      payload.producer !== 'catalog-svc' ||
      ![1, 2].includes(Number(payload.schema_version)) ||
      typeof payload.schema_version !== 'number' ||
      !['message_id', 'operation_id', 'correlation_id'].every(
        (key) =>
          typeof payload[key] === 'string' && UUID.test(payload[key] as string),
      ) ||
      typeof payload.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(payload.occurred_at)) ||
      !record(payload.data)
    ) {
      throw new InventoryMessageError('INVALID_MESSAGE');
    }
    const data = payload.data;
    if (
      typeof data.sku !== 'string' ||
      !data.sku.trim() ||
      typeof data.product_id !== 'string' ||
      !data.product_id.trim() ||
      (data.variant_id != null && typeof data.variant_id !== 'string') ||
      (data.default_location_id != null &&
        (typeof data.default_location_id !== 'string' ||
          !UUID.test(data.default_location_id)))
    ) {
      throw new InventoryMessageError('INVALID_MESSAGE');
    }
    return payload as unknown as Initialization;
  }

  private result(
    message: Initialization,
    status: InitializationResult['status'],
    code: string | null,
  ): InitializationResult {
    return {
      sku: message.data.sku,
      product_id: message.data.product_id,
      variant_id: message.data.variant_id ?? null,
      status,
      code,
      completed_at: new Date().toISOString(),
    };
  }

  private async enqueueResult(
    client: IDatabaseClient,
    message: Initialization,
    result: InitializationResult,
  ): Promise<void> {
    const name =
      result.status === 'INITIALIZED'
        ? 'inventory.sku.initialization.completed'
        : 'inventory.sku.initialization.rejected';
    const payload = this.outbox.createMessageEnvelope({
      eventName: name,
      kind: 'result',
      operationId: message.operation_id,
      correlationId: message.correlation_id,
      causationId: message.message_id,
      data: { ...result },
    });
    await this.outbox.enqueue(client, {
      event_id: String(payload.message_id),
      event_type: name,
      aggregate_type: 'stock',
      aggregate_id: message.data.sku,
      correlation_id: message.correlation_id,
      payload,
    });
  }
}
