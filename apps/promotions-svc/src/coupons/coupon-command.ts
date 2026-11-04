import { createHash } from 'node:crypto';
import { couponContracts } from './coupon-contract.generated.js';
import { matchesSchema, record } from './schema-validator.js';

export const consumptionName = 'promotions.coupon.consumption.requested';
export const restorationName = 'promotions.coupon.restoration.requested';
export interface CouponCommand {
  message_id: string;
  schema_version: 2;
  operation_id: string;
  occurred_at: string;
  correlation_id: string;
  causation_id: string;
  producer: 'modulo-ventas';
  kind: 'command';
  name: typeof consumptionName | typeof restorationName;
  data: Record<string, unknown> & {
    order_id: string;
    coupon_code?: string;
    customer_ref?: string | null;
    channel_id?: 'MARKETPLACE' | 'CHATBOT' | 'RETAIL';
    reservation_id?: string;
    commercial_snapshot_ref?: string;
    effective_at?: string;
    consumption_operation_id?: string | null;
    cancellation_reason?: string;
    cancelled_at?: string;
  };
}
export interface CouponResult {
  message_id: string;
  schema_version: 2;
  operation_id: string;
  occurred_at: string;
  correlation_id: string;
  causation_id: string;
  producer: 'promotions-svc';
  kind: 'result';
  name: string;
  data: Record<string, unknown>;
}

export function parseCouponCommand(
  value: unknown,
  actor: string,
): CouponCommand {
  if (
    !record(value) ||
    typeof value.name !== 'string' ||
    ![consumptionName, restorationName].includes(value.name) ||
    actor !== 'modulo-ventas' ||
    !matchesSchema(value, couponContracts[value.name].schema)
  ) {
    throw new Error('INVALID_COUPON_COMMAND');
  }
  return value as unknown as CouponCommand;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  if (record(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export function commandFingerprint(
  command: CouponCommand,
  actor: string,
): string {
  const data = { ...command.data };
  for (const key of ['effective_at', 'cancelled_at']) {
    if (typeof data[key] === 'string')
      data[key] = new Date(data[key]).toISOString();
  }
  if (command.name === consumptionName) {
    data.coupon_code = command.data.coupon_code
      ?.trim()
      .replace(/[a-z]/g, (letter) => letter.toUpperCase());
    data.customer_ref = command.data.customer_ref?.toLowerCase() ?? null;
    data.reservation_id = command.data.reservation_id?.toLowerCase();
  } else {
    data.consumption_operation_id =
      command.data.consumption_operation_id?.toLowerCase() ?? null;
  }
  return createHash('sha256')
    .update(canonicalJson({ actor, name: command.name, data }))
    .digest('hex');
}
