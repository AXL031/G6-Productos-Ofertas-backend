import { Injectable } from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import * as schema from '../../drizzle/schema.js';
import {
  IOperationsRepository,
  OperationEntity,
} from '../interfaces/operations.repository.interface.js';

@Injectable()
export class DrizzleOperationsRepository implements IOperationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async lockIdempotencyKey(
    client: IDatabaseClient,
    idempotencyKey: string,
  ): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [idempotencyKey],
    );
  }

  async findByOperationIdOrIdempotencyKey(
    operationId: string,
    idempotencyKey: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select()
        .from(schema.inventoryOperations)
        .where(
          or(
            eq(schema.inventoryOperations.operation_id, operationId),
            eq(schema.inventoryOperations.idempotency_key, idempotencyKey),
          ),
        );
      if (rows.length === 0) return null;
      return this.mapRow(rows[0]);
    }

    const sql = `
      SELECT id, operation_type, idempotency_key, intention, status,
             order_id, reservation_id, result_code, operation_id, client_id,
             request_fingerprint, request_payload, result_payload,
             accepted_at, applied_at, correlation_id
      FROM inventory.inventory_operations
      WHERE operation_id = $1 OR idempotency_key = $2
    `;
    const res = client
      ? await client.query(sql, [operationId, idempotencyKey])
      : await this.databaseService.query(sql, [operationId, idempotencyKey]);

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByOperationId(
    operationId: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select()
        .from(schema.inventoryOperations)
        .where(eq(schema.inventoryOperations.operation_id, operationId));
      if (rows.length === 0) return null;
      return this.mapRow(rows[0]);
    }

    const sql = `
      SELECT id, operation_type, idempotency_key, intention, status,
             order_id, reservation_id, result_code, operation_id, client_id,
             request_fingerprint, request_payload, result_payload,
             accepted_at, applied_at, correlation_id
      FROM inventory.inventory_operations
      WHERE operation_id = $1
    `;
    const res = client
      ? await client.query(sql, [operationId])
      : await this.databaseService.query(sql, [operationId]);

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findIncidenciaBloqueoByIncidenciaId(
    incidenciaId: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null> {
    const sql = `
      SELECT id, operation_type, idempotency_key, intention, status,
             order_id, reservation_id, result_code, operation_id, client_id,
             request_fingerprint, request_payload, result_payload,
             accepted_at, applied_at, correlation_id
      FROM inventory.inventory_operations
      WHERE operation_type = 'INCIDENCIA_BLOQUEO'
        AND result_payload->>'incidencia_id' = $1
      LIMIT 1
    `;
    const res = client
      ? await client.query(sql, [incidenciaId])
      : await this.databaseService.query(sql, [incidenciaId]);

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async create(
    client: IDatabaseClient,
    op: {
      operation_type: string;
      idempotency_key: string;
      intention: string;
      status: string;
      order_id?: string | null;
      reservation_id?: string | null;
      operation_id?: string | null;
      request_fingerprint?: string | null;
      request_payload?: string | null;
      result_payload?: string | null;
      correlation_id?: string | null;
      result_code?: string | null;
      client_id?: string | null;
    },
  ): Promise<void> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      await db.insert(schema.inventoryOperations).values({
        operation_type: op.operation_type as any,
        idempotency_key: op.idempotency_key,
        intention: op.intention,
        status: op.status as any,
        result_code: op.result_code ?? undefined,
        order_id: op.order_id ?? undefined,
        reservation_id: op.reservation_id ?? undefined,
        operation_id: op.operation_id ?? undefined,
        client_id: op.client_id ?? undefined,
        request_fingerprint: op.request_fingerprint ?? undefined,
        request_payload: op.request_payload
          ? typeof op.request_payload === 'string'
            ? JSON.parse(op.request_payload)
            : op.request_payload
          : undefined,
        result_payload: op.result_payload
          ? typeof op.result_payload === 'string'
            ? JSON.parse(op.result_payload)
            : op.result_payload
          : undefined,
        correlation_id: op.correlation_id ?? undefined,
        accepted_at: new Date(),
        applied_at: new Date(),
      });
      return;
    }

    const sql = `
      INSERT INTO inventory.inventory_operations (
        operation_type, idempotency_key, intention, status, result_code,
        order_id, reservation_id, accepted_at, applied_at,
        operation_id, request_fingerprint, request_payload, result_payload, correlation_id, client_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, now(), now(),
        $8, $9, $10, $11, $12, $13
      )
    `;
    await client.query(sql, [
      op.operation_type,
      op.idempotency_key,
      op.intention,
      op.status,
      op.result_code ?? null,
      op.order_id ?? null,
      op.reservation_id ?? null,
      op.operation_id ?? null,
      op.request_fingerprint ?? null,
      op.request_payload ?? null,
      op.result_payload ?? null,
      op.correlation_id ?? null,
      op.client_id ?? null,
    ]);
  }

  private mapRow(row: any): OperationEntity {
    return {
      id: row.id,
      operation_type: row.operation_type,
      idempotency_key: row.idempotency_key,
      intention: row.intention,
      status: row.status,
      order_id: row.order_id,
      reservation_id: row.reservation_id,
      result_code: row.result_code,
      operation_id: row.operation_id,
      client_id: row.client_id,
      request_fingerprint: row.request_fingerprint,
      request_payload: row.request_payload,
      result_payload: row.result_payload,
      accepted_at:
        typeof row.accepted_at === 'string'
          ? row.accepted_at
          : (row.accepted_at?.toISOString?.() ?? row.accepted_at),
      applied_at:
        typeof row.applied_at === 'string'
          ? row.applied_at
          : (row.applied_at?.toISOString?.() ?? row.applied_at),
      correlation_id: row.correlation_id,
    };
  }
}
