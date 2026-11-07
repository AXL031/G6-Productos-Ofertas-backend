import { validAuditTimestamp } from '../domain/audit-timestamp.js';
import { uuid, validateChange, type AuditChange } from '../domain/audit.js';
import { AuditHttpError } from '../http/audit-http.error.js';
import { record } from '../http/audit-read.guard.js';

const fields = [
  'target_type',
  'product_id',
  'sku',
  'channel_id',
  'currency',
  'price_type',
  'previous_price',
  'new_price',
  'operation',
  'reason',
  'price_version',
  'valid_from',
  'batch_id',
  'actor',
];
const positive = /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.(?:0*[1-9][0-9]*))$/;

// DEC-G6-INT-06: decimal exacto, escala 2, HALF_UP (también para negativos).
export function percentage(
  previous: string | null,
  next: string | null,
): string | null {
  if (previous === null || next === null) return null;
  const scale = Math.max(
    previous.split('.')[1]?.length ?? 0,
    next.split('.')[1]?.length ?? 0,
  );
  const units = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  };
  const before = units(previous);
  if (before === 0n) return null;
  const delta = units(next) - before;
  const magnitude = (delta < 0n ? -delta : delta) * 10000n;
  const rounded =
    magnitude / before + ((magnitude % before) * 2n >= before ? 1n : 0n);
  return `${delta < 0n && rounded !== 0n ? '-' : ''}${rounded / 100n}.${String(rounded % 100n).padStart(2, '0')}`;
}

export function decodePriceChange(
  data: Record<string, unknown>,
  occurredAt: Date,
): AuditChange[] {
  const invalid = (): never => {
    throw new AuditHttpError(400, 'VALIDACION');
  };
  if (
    Object.keys(data).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(data, key))
  )
    invalid();
  const actor = data.actor;
  if (!record(actor)) return invalid();
  if (
    Object.keys(actor).length !== 3 ||
    !['user_id', 'email', 'ip'].every(
      (key) =>
        Object.hasOwn(actor, key) &&
        (actor[key] === null || typeof actor[key] === 'string'),
    ) ||
    (actor.email !== null && !/^[^\s@]+@[^\s@]+$/.test(String(actor.email))) ||
    !['PRODUCTO', 'SKU'].includes(String(data.target_type)) ||
    (data.target_type === 'PRODUCTO'
      ? data.sku !== null
      : typeof data.sku !== 'string' || !data.sku.length) ||
    typeof data.product_id !== 'string' ||
    !data.product_id.trim() ||
    !(
      data.channel_id === null ||
      ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'].includes(
        String(data.channel_id),
      )
    ) ||
    typeof data.currency !== 'string' ||
    data.currency.length !== 3 ||
    !Number.isSafeInteger(data.price_version) ||
    Number(data.price_version) < 1 ||
    !validAuditTimestamp(data.valid_from) ||
    (data.batch_id !== null &&
      (typeof data.batch_id !== 'string' || !uuid.test(data.batch_id))) ||
    ![data.previous_price, data.new_price].every(
      (value) =>
        value === null || (typeof value === 'string' && positive.test(value)),
    ) ||
    !['REGULAR', 'OFERTA'].includes(String(data.price_type)) ||
    !['CREACION', 'MODIFICACION', 'RETIRO_OFERTA'].includes(
      String(data.operation),
    ) ||
    typeof data.reason !== 'string' ||
    !data.reason.trim()
  )
    invalid();
  const previous = data.previous_price as string | null;
  const next = data.new_price as string | null;
  const canonical = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole).toString() + '.' + fraction.replace(/0+$/, '');
  };
  if (
    data.operation === 'MODIFICACION' &&
    previous !== null &&
    next !== null &&
    canonical(previous) === canonical(next)
  )
    invalid();
  return [
    validateChange({
      targetType: data.target_type as 'PRODUCTO' | 'SKU',
      sku: data.sku as string | null,
      productId: data.product_id as string,
      priceType: data.price_type as AuditChange['priceType'],
      previous,
      next,
      variation:
        data.operation === 'MODIFICACION' ? percentage(previous, next) : null,
      operation: data.operation as AuditChange['operation'],
      channel: data.channel_id as string | null,
      reason: data.reason as string,
      batchId: data.batch_id as string | null,
      userId: actor.user_id as string | null,
      email: actor.email as string | null,
      ip: actor.ip as string | null,
      at: occurredAt,
    }),
  ];
}
