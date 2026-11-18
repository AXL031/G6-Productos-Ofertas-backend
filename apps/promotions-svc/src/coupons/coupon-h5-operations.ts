import { randomUUID } from 'node:crypto';
import {
  inPromotionsTransaction,
  type SqlPool,
} from '../infrastructure/persistence/sql-transaction.js';
import { couponH5Schemas } from './coupon-h5-contract.generated.js';
import { couponContracts } from './coupon-contract.generated.js';
import { matchesSchema, record } from './schema-validator.js';
import {
  canonicalJson,
  commandFingerprint,
  consumptionName,
  restorationName,
  parseCouponCommand,
  type CouponCommand,
  type CouponResult,
} from './coupon-command.js';
import type { CouponCommandProcessor } from './coupon-transactions.js';

export const couponH5Queue = 'g6.promotions.commands';
export type CouponH5Kind = 'CONSUMIR_CUPON' | 'RESTAURAR_CUPON';
export interface CouponH5Admission {
  command: CouponCommand;
  actor: 'modulo-ventas';
  fingerprint: string;
  kind: CouponH5Kind;
}

// Candidate application boundary, not an HTTP controller. A future authorized
// adapter must obtain actor from a verified G7 identity, never from request data.
export function prepareCouponH5Admission(
  kind: CouponH5Kind,
  body: unknown,
  idempotencyKey: string,
  actor: string,
  correlationId: string,
  now = new Date(),
): CouponH5Admission {
  if (actor !== 'modulo-ventas') throw new Error('SCOPE_INSUFICIENTE');
  const name = kind === 'CONSUMIR_CUPON' ? consumptionName : restorationName;
  const schema =
    couponH5Schemas[
      kind === 'CONSUMIR_CUPON'
        ? 'CouponConsumptionRequest'
        : 'CouponRestorationRequest'
    ];
  if (
    !['CONSUMIR_CUPON', 'RESTAURAR_CUPON'].includes(kind) ||
    !record(body) ||
    !matchesSchema(body, schema) ||
    !matchesSchema(idempotencyKey, { type: 'string', format: 'uuid' }) ||
    !matchesSchema(correlationId, { type: 'string', format: 'uuid' }) ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('VALIDACION');
  // The OpenAPI baseline distinguishes malformed keys from different UUIDs.
  if (String(body.operation_id).toLowerCase() !== idempotencyKey.toLowerCase())
    throw new Error('IDEMPOTENCY_CONFLICT');
  if (
    kind === 'CONSUMIR_CUPON' &&
    body.commercial_snapshot_ref !== body.order_id
  )
    throw new Error('VALIDACION');
  const { operation_id, ...data } = body;
  const command = parseCouponCommand(
    {
      message_id: randomUUID(),
      schema_version: 2,
      operation_id: String(operation_id).toLowerCase(),
      occurred_at: now.toISOString(),
      correlation_id: correlationId,
      causation_id: String(operation_id).toLowerCase(),
      producer: 'modulo-ventas',
      kind: 'command',
      name,
      data,
    },
    actor,
  );
  return {
    command,
    actor,
    fingerprint: commandFingerprint(command, actor),
    kind,
  };
}

export class CouponH5Operations {
  constructor(private readonly pool: SqlPool) {}

  async admit(
    request: CouponH5Admission,
  ): Promise<{ replay: boolean; snapshot: Record<string, unknown> }> {
    return inPromotionsTransaction(this.pool, async (client) => {
      const c = parseCouponCommand(request.command, request.actor);
      const candidate =
        couponH5Schemas[
          c.name === consumptionName
            ? 'CouponConsumptionRequest'
            : 'CouponRestorationRequest'
        ];
      if (
        request.actor !== 'modulo-ventas' ||
        request.fingerprint !== commandFingerprint(c, request.actor) ||
        request.kind !==
          (c.name === consumptionName ? 'CONSUMIR_CUPON' : 'RESTAURAR_CUPON') ||
        !matchesSchema(
          { operation_id: c.operation_id, ...c.data },
          candidate,
        ) ||
        (c.name === consumptionName &&
          c.data.commercial_snapshot_ref !== c.data.order_id)
      )
        throw new Error('VALIDACION');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('promotions:operation:' || $1,0))",
        [c.operation_id],
      );
      const found = await client.query(
        'SELECT * FROM promotions.h5_coupon_operations WHERE operation_id=$1',
        [c.operation_id],
      );
      const row = found.rows[0];
      if (row) {
        if (
          row.source_client_id !== request.actor ||
          row.request_fingerprint !== request.fingerprint ||
          row.operation_type !== request.kind
        )
          throw new Error('IDEMPOTENCY_CONFLICT');
        return { replay: true, snapshot: this.snapshot(row) };
      }
      // Serialize against the existing H4 processor and preserve its receipt;
      // a transport cut never creates a fresh idempotency namespace.
      const prior = await client.query(
        'SELECT * FROM promotions.coupon_command_receipts WHERE operation_id=$1',
        [c.operation_id],
      );
      const receipt = prior.rows[0];
      if (
        receipt &&
        (receipt.request_fingerprint !== request.fingerprint ||
          receipt.source_client_id !== request.actor ||
          receipt.intention !==
            (c.name === consumptionName ? 'CONSUMIR' : 'RESTAURAR'))
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      if (
        receipt &&
        (!['COMPLETED', 'REJECTED'].includes(String(receipt.status)) ||
          !record(receipt.result_payload) ||
          typeof receipt.result_payload.name !== 'string' ||
          !couponContracts[receipt.result_payload.name] ||
          !matchesSchema(
            receipt.result_payload,
            couponContracts[receipt.result_payload.name].schema,
          ))
      )
        throw new Error('COUPON_H5_LEGACY_RESULT_UNAVAILABLE');
      const inserted = await client.query(
        `INSERT INTO promotions.h5_coupon_operations
        (operation_id,message_id,source_client_id,order_id,operation_type,request_fingerprint,command)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
        [
          c.operation_id,
          c.message_id,
          request.actor,
          c.data.order_id,
          request.kind,
          request.fingerprint,
          JSON.stringify(c),
        ],
      );
      if (receipt) {
        const legacy = receipt.result_payload as unknown as CouponResult;
        if (
          legacy.operation_id !== c.operation_id ||
          legacy.data.order_id !== c.data.order_id
        )
          throw new Error('COUPON_H5_LEGACY_RESULT_UNAVAILABLE');
        const snapshot = this.snapshot({
          ...inserted.rows[0],
          status: receipt.status,
          result_payload: legacy,
          completed_at: legacy.occurred_at,
          updated_at: legacy.occurred_at,
        });
        await client.query(
          `UPDATE promotions.h5_coupon_operations SET status=$2,
          result_payload=$3::jsonb,completed_at=$4,updated_at=$4 WHERE operation_id=$1`,
          [
            c.operation_id,
            receipt.status,
            JSON.stringify(legacy),
            legacy.occurred_at,
          ],
        );
        return { replay: true, snapshot };
      }
      await client.query(
        `INSERT INTO promotions.h5_coupon_outbox (message_id,operation_id,destination)
        VALUES ($1,$2,$3)`,
        [c.message_id, c.operation_id, couponH5Queue],
      );
      return { replay: false, snapshot: this.snapshot(inserted.rows[0]) };
    });
  }

  async get(
    operationId: string,
    orderId: string,
    actor: string,
  ): Promise<Record<string, unknown> | undefined> {
    return inPromotionsTransaction(
      this.pool,
      async (client) => {
        const result = await client.query(
          `SELECT * FROM promotions.h5_coupon_operations
        WHERE operation_id=$1 AND order_id=$2 AND source_client_id=$3`,
          [operationId, orderId, actor],
        );
        return result.rows[0] ? this.snapshot(result.rows[0]) : undefined;
      },
      true,
    );
  }

  async commandFor(messageId: string): Promise<CouponCommand | undefined> {
    return inPromotionsTransaction(
      this.pool,
      async (client) => {
        const result = await client.query(
          'SELECT command FROM promotions.h5_coupon_operations WHERE message_id=$1',
          [messageId],
        );
        return result.rows[0]
          ? parseCouponCommand(result.rows[0].command, 'modulo-ventas')
          : undefined;
      },
      true,
    );
  }

  async finish(command: CouponCommand, result: CouponResult): Promise<void> {
    if (
      !couponContracts[result.name] ||
      !matchesSchema(result, couponContracts[result.name].schema) ||
      result.operation_id !== command.operation_id ||
      result.data.order_id !== command.data.order_id ||
      ![
        command.name.replace('.requested', '.completed'),
        command.name.replace('.requested', '.rejected'),
      ].includes(result.name)
    )
      throw new Error('INVALID_COUPON_H5_RESULT');
    await inPromotionsTransaction(this.pool, async (client) => {
      const locked = await client.query(
        'SELECT * FROM promotions.h5_coupon_operations WHERE operation_id=$1 FOR UPDATE',
        [command.operation_id],
      );
      const row = locked.rows[0];
      if (
        !row ||
        row.message_id !== command.message_id ||
        canonicalJson(row.command) !== canonicalJson(command)
      )
        throw new Error('INVALID_COUPON_H5_RESULT');
      if (row.result_payload !== null) {
        if (canonicalJson(row.result_payload) !== canonicalJson(result))
          throw new Error('IDEMPOTENCY_CONFLICT');
        return;
      }
      const status = result.name.endsWith('.rejected')
        ? 'REJECTED'
        : 'COMPLETED';
      const proposed = {
        ...row,
        status,
        result_payload: result,
        completed_at: result.occurred_at,
        updated_at: result.occurred_at,
      };
      this.snapshot(proposed);
      await client.query(
        `UPDATE promotions.h5_coupon_operations SET status=$2,
        result_payload=$3::jsonb,completed_at=$4,updated_at=$4 WHERE operation_id=$1`,
        [
          command.operation_id,
          status,
          JSON.stringify(result),
          result.occurred_at,
        ],
      );
    });
  }

  private snapshot(row: Record<string, unknown>): Record<string, unknown> {
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    const data = record(row.result_payload) ? row.result_payload.data : null;
    const allowed =
      couponH5Schemas.CouponOperationSnapshot.properties?.result.oneOf?.find(
        (s) => s.type === 'object',
      )?.properties;
    // The legacy result also contains cupon_id. Preserve the full durable result
    // internally and project only the explicitly proposed public fields.
    const result =
      record(data) && allowed
        ? Object.fromEntries(
            Object.entries(data).filter(([key]) => Object.hasOwn(allowed, key)),
          )
        : null;
    const snapshot = {
      operation_id: row.operation_id,
      operation_type: row.operation_type,
      status: row.status,
      order_id: row.order_id,
      accepted_at: iso(row.accepted_at),
      updated_at: iso(row.updated_at),
      completed_at: iso(row.completed_at),
      result,
    };
    if (!matchesSchema(snapshot, couponH5Schemas.CouponOperationSnapshot))
      throw new Error('INVALID_COUPON_H5_SNAPSHOT');
    return snapshot;
  }
}

export class CouponH5Worker {
  constructor(
    private readonly operations: Pick<
      CouponH5Operations,
      'commandFor' | 'finish'
    >,
    private readonly processor: Pick<CouponCommandProcessor, 'process'>,
  ) {}

  async process(command: CouponCommand): Promise<void> {
    const admitted = await this.operations.commandFor(command.message_id);
    if (!admitted || canonicalJson(admitted) !== canonicalJson(command))
      throw new Error('INVALID_COUPON_H5_COMMAND');
    const result = await this.processor.process(admitted, 'modulo-ventas');
    // Processor commits receipt + business effect + result Outbox. If this second
    // transaction fails, redelivery recovers that receipt without another effect.
    await this.operations.finish(admitted, result);
  }
}
