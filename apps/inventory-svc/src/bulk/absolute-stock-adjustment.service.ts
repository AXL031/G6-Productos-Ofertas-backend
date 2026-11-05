import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { IDatabaseClient } from '../database/database.interface.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  OPERATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal domain input only; it is not the untyped Bulk AMQP payload. */
export interface AbsoluteStockAdjustment {
  operation_id: string;
  sku: string;
  location_id: string;
  expected_stock_version: number;
  target_on_hand: number;
  correlation_id?: string;
}

export interface AbsoluteStockAdjustmentResult {
  operation_id: string;
  sku: string;
  location_id: string;
  status: 'APPLIED' | 'REJECTED';
  code:
    | 'VERSION_STALE'
    | 'SKU_LOCATION_NOT_FOUND'
    | 'TARGET_BELOW_COMMITTED_UNITS'
    | null;
  on_hand: number | null;
  reserved: number | null;
  blocked: number | null;
  available: number | null;
  stock_version: number | null;
}

@Injectable()
export class AbsoluteStockAdjustmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly kardex: KardexService,
    private readonly outbox: OutboxService,
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operations: IOperationsRepository,
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stock: IStockBalanceRepository,
  ) {}

  /**
   * Applies an absolute on_hand target under a version lock. It is deliberately
   * not wired to AMQP until Bulk publishes an approved typed command schema.
   */
  async apply(
    input: AbsoluteStockAdjustment,
  ): Promise<AbsoluteStockAdjustmentResult> {
    this.validate(input);
    const clientId = 'bulk-svc';
    const idempotencyKey = `bulk-adjust:${input.operation_id}`;
    const fingerprint = this.idempotency.computeFingerprint({
      sku: input.sku,
      location_id: input.location_id,
      expected_stock_version: input.expected_stock_version,
      target_on_hand: input.target_on_hand,
    });
    const correlationId = input.correlation_id ?? input.operation_id;

    return this.database.transaction(async (client) => {
      await this.operations.lockIdempotencyKey(client, idempotencyKey);
      const existing = await this.operations.findByOperationIdOrIdempotencyKey(
        input.operation_id,
        idempotencyKey,
        client,
      );
      if (existing) {
        if (
          existing.operation_id !== input.operation_id ||
          existing.idempotency_key !== idempotencyKey ||
          existing.client_id !== clientId ||
          existing.intention !== 'bulk.absolute-stock-adjustment' ||
          !this.idempotency.isMatchingFingerprint(
            existing.request_fingerprint,
            fingerprint,
          )
        ) {
          throw new Error('Conflicto de idempotencia en ajuste absoluto');
        }
        const result = this.parseResult(existing.result_payload);
        if (result.operation_id !== input.operation_id) {
          throw new Error('Resultado durable de ajuste absoluto inconsistente');
        }
        return result;
      }

      const balance = await this.stock.findBySkuAndLocationForUpdate(
        client,
        input.sku,
        input.location_id,
      );
      if (!balance) {
        const result = this.result(input, 'REJECTED', 'SKU_LOCATION_NOT_FOUND');
        await this.persist(
          client,
          input,
          clientId,
          idempotencyKey,
          fingerprint,
          result,
        );
        return result;
      }
      if (balance.stock_version !== input.expected_stock_version) {
        const result = this.result(input, 'REJECTED', 'VERSION_STALE', balance);
        await this.persist(
          client,
          input,
          clientId,
          idempotencyKey,
          fingerprint,
          result,
        );
        return result;
      }
      if (input.target_on_hand < balance.reserved + balance.blocked) {
        const result = this.result(
          input,
          'REJECTED',
          'TARGET_BELOW_COMMITTED_UNITS',
          balance,
        );
        await this.persist(
          client,
          input,
          clientId,
          idempotencyKey,
          fingerprint,
          result,
        );
        return result;
      }

      const delta = input.target_on_hand - balance.on_hand;
      const nextVersion = balance.stock_version + (delta === 0 ? 0 : 1);
      if (delta !== 0) {
        const affected = await this.stock.updateStock(
          client,
          input.sku,
          input.location_id,
          {
            on_hand: input.target_on_hand,
            stock_version: nextVersion,
          },
        );
        if (affected !== 1) {
          throw new Error(
            'El ajuste absoluto no actualizó exactamente un saldo',
          );
        }
        await this.kardex.recordMovement(client, {
          sku_id: input.sku,
          location_id: input.location_id,
          operation_type: 'AJUSTE_ABSOLUTO',
          operation_id: input.operation_id,
          quantity: delta,
          on_hand_before: balance.on_hand,
          on_hand_after: input.target_on_hand,
          reserved_before: balance.reserved,
          reserved_after: balance.reserved,
          blocked_before: balance.blocked,
          blocked_after: balance.blocked,
          stock_version: nextVersion,
          correlation_id: correlationId,
        });
      }
      const nextBalance = {
        ...balance,
        on_hand: input.target_on_hand,
        stock_version: nextVersion,
        available: input.target_on_hand - balance.reserved - balance.blocked,
      };
      const result = this.result(input, 'APPLIED', null, nextBalance);
      await this.persist(
        client,
        input,
        clientId,
        idempotencyKey,
        fingerprint,
        result,
      );
      if (delta !== 0) {
        await this.outbox.stockChanged(client, {
          sku: input.sku,
          location_id: input.location_id,
          on_hand: nextBalance.on_hand,
          reserved: nextBalance.reserved,
          blocked: nextBalance.blocked,
          stock_version: nextBalance.stock_version,
          operationId: input.operation_id,
          correlationId,
        });
      }
      return result;
    });
  }

  private validate(input: AbsoluteStockAdjustment): void {
    if (
      !input ||
      !UUID.test(input.operation_id) ||
      typeof input.sku !== 'string' ||
      !input.sku.trim() ||
      !UUID.test(input.location_id) ||
      !Number.isSafeInteger(input.expected_stock_version) ||
      input.expected_stock_version < 0 ||
      !Number.isSafeInteger(input.target_on_hand) ||
      input.target_on_hand < 0 ||
      (input.correlation_id !== undefined && !UUID.test(input.correlation_id))
    ) {
      throw new RangeError('Entrada de ajuste absoluto inválida');
    }
  }

  private result(
    input: AbsoluteStockAdjustment,
    status: AbsoluteStockAdjustmentResult['status'],
    code: AbsoluteStockAdjustmentResult['code'],
    balance?: {
      on_hand: number;
      reserved: number;
      blocked: number;
      available: number;
      stock_version: number;
    },
  ): AbsoluteStockAdjustmentResult {
    return {
      operation_id: input.operation_id,
      sku: input.sku,
      location_id: input.location_id,
      status,
      code,
      on_hand: balance?.on_hand ?? null,
      reserved: balance?.reserved ?? null,
      blocked: balance?.blocked ?? null,
      available: balance?.available ?? null,
      stock_version: balance?.stock_version ?? null,
    };
  }

  private async persist(
    client: IDatabaseClient,
    input: AbsoluteStockAdjustment,
    clientId: string,
    idempotencyKey: string,
    fingerprint: string,
    result: AbsoluteStockAdjustmentResult,
  ): Promise<void> {
    await this.operations.create(client, {
      operation_type: 'AJUSTE_ABSOLUTO',
      idempotency_key: idempotencyKey,
      intention: 'bulk.absolute-stock-adjustment',
      status: result.status === 'APPLIED' ? 'APLICADO' : 'RECHAZADO',
      operation_id: input.operation_id,
      client_id: clientId,
      request_fingerprint: fingerprint,
      request_payload: JSON.stringify(input),
      result_payload: JSON.stringify(result),
      correlation_id: input.correlation_id ?? input.operation_id,
      result_code: result.code,
    });
  }

  private parseResult(value: unknown): AbsoluteStockAdjustmentResult {
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !result ||
      typeof result !== 'object' ||
      !('status' in result) ||
      !['APPLIED', 'REJECTED'].includes(String(result.status))
    ) {
      throw new Error('Resultado durable de ajuste absoluto inconsistente');
    }
    return result as AbsoluteStockAdjustmentResult;
  }
}
