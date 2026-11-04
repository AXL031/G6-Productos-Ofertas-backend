import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  commandFingerprint,
  consumptionName,
  parseCouponCommand,
  type CouponCommand,
  type CouponResult,
} from './coupon-command.js';
import { couponContracts } from './coupon-contract.generated.js';
import { matchesSchema } from './schema-validator.js';
import {
  inPromotionsTransaction,
  type SqlClient,
} from '../infrastructure/persistence/sql-transaction.js';
export type {
  SqlClient,
  SqlPool,
} from '../infrastructure/persistence/sql-transaction.js';
export interface ConsumptionEvidence {
  reservationConfirmed: boolean;
  snapshotDurable: boolean;
  eligible: boolean;
  orderId: string;
  reservationId: string;
  commercialSnapshotRef: string;
}
// Must be backed by authorized durable evidence and authoritative eligibility.
// No production fallback is provided for this integration boundary.
export interface CouponEvidenceProvider<C extends SqlClient = SqlClient> {
  verify(
    command: CouponCommand,
    signal: AbortSignal,
  ): Promise<ConsumptionEvidence>;
  revalidate?(
    command: CouponCommand,
    evidence: ConsumptionEvidence,
    client: C,
  ): Promise<ConsumptionEvidence>;
}
const businessErrors = new Set([
  'COUPON_NOT_FOUND',
  'COUPON_NOT_ELIGIBLE',
  'CUSTOMER_REF_REQUERIDO',
  'COUPON_GLOBAL_LIMIT',
  'COUPON_CUSTOMER_LIMIT',
  'COUPON_IDENTITY_MISMATCH',
  'INVALID_RESTORATION_REQUEST',
]);
const handler = 'coupon-commands-v2';

export class CouponCommandProcessor<C extends SqlClient = SqlClient> {
  constructor(
    private readonly pool: { connect(): Promise<C> },
    private readonly evidence: CouponEvidenceProvider<C>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(value: unknown, actor: string): Promise<CouponResult> {
    const command = parseCouponCommand(value, actor);
    const fingerprint = commandFingerprint(command, actor);
    try {
      return await inPromotionsTransaction(this.pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('promotions:order:' || $1, 0))",
          [command.data.order_id],
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('promotions:operation:' || $1, 0))",
          [command.operation_id.toLowerCase()],
        );
        const inbox = await client.query(
          'SELECT promotions.fn_begin_inbox($1::jsonb, $2) AS fresh',
          [JSON.stringify(command), handler],
        );
        let result: CouponResult;
        if (inbox.rows[0].fresh === false) {
          const previous = await client.query(
            'SELECT result FROM promotions.inbox WHERE message_id=$1 AND handler=$2',
            [command.message_id, handler],
          );
          result = this.savedResult(previous.rows[0]?.result);
        } else {
          const existing = await client.query(
            'SELECT * FROM promotions.coupon_command_receipts WHERE operation_id=$1',
            [command.operation_id],
          );
          const receipt = existing.rows[0];
          const intention =
            command.name === consumptionName ? 'CONSUMIR' : 'RESTAURAR';
          if (
            receipt &&
            (receipt.request_fingerprint !== fingerprint ||
              receipt.source_client_id !== actor ||
              receipt.intention !== intention)
          ) {
            result = this.result(command, {}, 'IDEMPOTENCY_CONFLICT');
            await this.enqueue(client, result);
          } else if (receipt) {
            result = this.savedResult(receipt.result_payload);
          } else {
            await client.query(
              `INSERT INTO promotions.coupon_command_receipts
            (operation_id,order_id,source_client_id,intention,coupon_code,reservation_id,commercial_snapshot_ref,request_fingerprint,request_payload)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
              [
                command.operation_id,
                command.data.order_id,
                actor,
                intention,
                command.data.coupon_code ?? null,
                command.data.reservation_id ?? null,
                command.data.commercial_snapshot_ref ?? null,
                fingerprint,
                JSON.stringify(command.data),
              ],
            );
            await client.query('SAVEPOINT coupon_business');
            try {
              const data =
                command.name === consumptionName
                  ? await this.consume(client, command)
                  : await this.restore(client, command);
              result = this.result(command, data);
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !businessErrors.has(error.message)
              )
                throw error;
              await client.query('ROLLBACK TO SAVEPOINT coupon_business');
              result = this.result(command, {}, error.message);
            }
            await client.query('RELEASE SAVEPOINT coupon_business');
            await this.enqueue(client, result);
            await client.query(
              `UPDATE promotions.coupon_command_receipts SET status=$2,
            result_payload=$3::jsonb, completed_at=$4 WHERE operation_id=$1`,
              [
                command.operation_id,
                result.name.endsWith('.rejected') ? 'REJECTED' : 'COMPLETED',
                JSON.stringify(result),
                result.occurred_at,
              ],
            );
          }
          await client.query(
            'UPDATE promotions.inbox SET completed_at=$3,result=$4::jsonb WHERE message_id=$1 AND handler=$2',
            [
              command.message_id,
              handler,
              this.clock().toISOString(),
              JSON.stringify(result),
            ],
          );
        }
        return result;
      });
    } catch (error) {
      // No driver diagnostics or secret-bearing errors cross this boundary.
      if (
        error instanceof Error &&
        error.message === 'COUPON_EVIDENCE_UNAVAILABLE'
      )
        throw error;
      throw new Error('COUPON_COMMAND_FAILED');
    }
  }

  private savedResult(value: unknown): CouponResult {
    if (
      value === null ||
      typeof value !== 'object' ||
      !('name' in value) ||
      typeof value.name !== 'string' ||
      !couponContracts[value.name] ||
      (!value.name.endsWith('.completed') &&
        !value.name.endsWith('.rejected')) ||
      !matchesSchema(value, couponContracts[value.name].schema)
    )
      throw new Error('INVALID_SAVED_RESULT');
    return value as CouponResult;
  }

  private async consume(
    client: C,
    command: CouponCommand,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proof: ConsumptionEvidence;
    try {
      proof = await Promise.race([
        this.evidence.verify(command, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('COUPON_EVIDENCE_UNAVAILABLE'));
          }, 1000);
        }),
      ]);
    } catch {
      throw new Error('COUPON_EVIDENCE_UNAVAILABLE');
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Await local SQL outside the external-evidence race: a deadline must never
    // release the client while a verifier is still using that transaction.
    if (this.evidence.revalidate) {
      try {
        proof = await this.evidence.revalidate(command, proof, client);
      } catch {
        throw new Error('COUPON_EVIDENCE_UNAVAILABLE');
      }
    }
    if (
      !proof.reservationConfirmed ||
      !proof.snapshotDurable ||
      !proof.eligible ||
      proof.orderId !== command.data.order_id ||
      proof.reservationId.toLowerCase() !==
        command.data.reservation_id?.toLowerCase() ||
      proof.commercialSnapshotRef !== command.data.commercial_snapshot_ref
    )
      throw new Error('COUPON_NOT_ELIGIBLE');
    const coupon = await client.query(
      'SELECT id FROM promotions.coupons WHERE code=promotions.fn_normalize_code($1)',
      [command.data.coupon_code],
    );
    if (!coupon.rows[0]) throw new Error('COUPON_NOT_FOUND');
    const consumed = await client.query(
      'SELECT promotions.fn_consume_coupon($1,$2,$3,$4,$5) AS id',
      [
        command.data.order_id,
        coupon.rows[0].id,
        command.data.customer_ref ?? null,
        command.data.channel_id,
        command.data.effective_at,
      ],
    );
    return { consumption_id: consumed.rows[0].id };
  }

  private async restore(
    client: SqlClient,
    command: CouponCommand,
  ): Promise<Record<string, unknown>> {
    const operation = command.data.consumption_operation_id;
    let expectedConsumption: unknown;
    if (operation) {
      const receipt = await client.query(
        `SELECT result_payload FROM promotions.coupon_command_receipts
        WHERE operation_id=$1 AND order_id=$2 AND intention='CONSUMIR' AND status='COMPLETED' AND source_client_id=$3`,
        [operation, command.data.order_id, command.producer],
      );
      if (!receipt.rows[0]) throw new Error('COUPON_IDENTITY_MISMATCH');
      expectedConsumption = this.savedResult(receipt.rows[0].result_payload)
        .data.consumption_id;
    }
    const uses = await client.query(
      `SELECT id,coupon_id,consumed_at,cancellation_policy,restored_at FROM promotions.coupon_uses
       WHERE order_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY coupon_id`,
      [command.data.order_id, expectedConsumption ?? null],
    );
    if (
      uses.rows.length > 1 ||
      (expectedConsumption && uses.rows[0]?.id !== expectedConsumption)
    )
      throw new Error('COUPON_IDENTITY_MISMATCH');
    if (uses.rows[0]) {
      const consumedAt = uses.rows[0].consumed_at;
      const consumedTime =
        consumedAt instanceof Date
          ? consumedAt.getTime()
          : Date.parse(String(consumedAt));
      if (Date.parse(command.data.cancelled_at ?? '') < consumedTime)
        throw new Error('INVALID_RESTORATION_REQUEST');
    }
    const row = uses.rows[0];
    let outcome = 'NO_CONSUMPTION';
    if (row) {
      await client.query(
        'SELECT id FROM promotions.coupons WHERE id=$1 FOR UPDATE',
        [row.coupon_id],
      );
      if (row.cancellation_policy === 'NO_RESTAURAR')
        outcome = 'POLICY_KEEPS_CONSUMPTION';
      else {
        await client.query(
          'UPDATE promotions.coupon_uses SET restored_at=$2 WHERE id=$1 AND restored_at IS NULL',
          [row.id, command.data.cancelled_at],
        );
        outcome = 'RESTORED';
      }
    }
    return {
      cupon_id: row?.coupon_id ?? null,
      consumption_operation_id: operation ?? null,
      restored: outcome === 'RESTORED',
      outcome,
    };
  }

  private result(
    command: CouponCommand,
    data: Record<string, unknown>,
    rejection?: string,
  ): CouponResult {
    const timestamp = this.clock().toISOString();
    const consumption = command.name === consumptionName;
    const result: CouponResult = {
      message_id: randomUUID(),
      schema_version: 2,
      operation_id: command.operation_id,
      occurred_at: timestamp,
      correlation_id: command.correlation_id,
      causation_id: command.message_id,
      producer: 'promotions-svc',
      kind: 'result',
      name: command.name.replace(
        /requested$/,
        rejection ? 'rejected' : 'completed',
      ),
      data: {
        order_id: command.data.order_id,
        ...(consumption
          ? {
              coupon_code: command.data.coupon_code,
              reservation_id: command.data.reservation_id,
              commercial_snapshot_ref: command.data.commercial_snapshot_ref,
              decided_at: timestamp,
            }
          : {
              completed_at: timestamp,
              consumption_operation_id:
                command.data.consumption_operation_id ?? null,
            }),
        ...data,
        ...(rejection ? { result_code: rejection } : {}),
      },
    };
    if (!matchesSchema(result, couponContracts[result.name].schema))
      throw new Error('INVALID_COUPON_RESULT');
    return result;
  }

  private async enqueue(
    client: SqlClient,
    result: CouponResult,
  ): Promise<void> {
    await client.query(
      `INSERT INTO promotions.outbox
      (message_id,schema_version,occurred_at,correlation_id,causation_id,operation_id,producer,kind,name,data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        result.message_id,
        result.schema_version,
        result.occurred_at,
        result.correlation_id,
        result.causation_id,
        result.operation_id,
        result.producer,
        result.kind,
        result.name,
        canonicalJson(result.data),
      ],
    );
  }
}
