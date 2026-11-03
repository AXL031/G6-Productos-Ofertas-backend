import { AuditHttpError } from '../http/audit-http.error.js';

export interface AuditChange {
  targetType?: 'PRODUCTO' | 'SKU';
  sku: string | null;
  productId: string;
  priceType: 'REGULAR' | 'OFERTA';
  previous: string | null;
  next: string | null;
  variation: string | null;
  operation: 'CREACION' | 'MODIFICACION' | 'RETIRO_OFERTA';
  channel: string | null;
  reason: string;
  batchId: string | null;
  userId: string | null;
  email: string | null;
  ip: string | null;
  at: Date;
}
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validMoney(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
}
export function validateChange(change: AuditChange): AuditChange {
  const invalid = () => {
    throw new AuditHttpError(400, 'VALIDACION');
  };
  if (
    !change ||
    ![change.productId, change.reason].every(
      (v) => typeof v === 'string' && v.trim(),
    ) ||
    (change.targetType !== undefined &&
      !['PRODUCTO', 'SKU'].includes(change.targetType)) ||
    (change.targetType === 'PRODUCTO'
      ? change.sku !== null
      : typeof change.sku !== 'string' || !change.sku.trim()) ||
    !(
      change.channel === null ||
      (typeof change.channel === 'string' && change.channel.trim())
    ) ||
    !['REGULAR', 'OFERTA'].includes(change.priceType) ||
    !(change.at instanceof Date) ||
    !Number.isFinite(change.at.getTime()) ||
    (change.batchId !== null &&
      (typeof change.batchId !== 'string' || !uuid.test(change.batchId))) ||
    ![change.userId, change.email, change.ip].every(
      (v) => v === null || typeof v === 'string',
    ) ||
    ![change.previous, change.next].every((v) => v === null || validMoney(v)) ||
    (change.variation !== null &&
      (typeof change.variation !== 'string' ||
        !/^-?\d+(?:\.\d+)?$/.test(change.variation) ||
        !Number.isFinite(Number(change.variation))))
  )
    invalid();
  if (change.operation === 'CREACION') {
    if (
      change.previous !== null ||
      change.next === null ||
      change.variation !== null
    )
      invalid();
  } else if (change.operation === 'MODIFICACION') {
    if (
      change.previous === null ||
      change.next === null ||
      (change.previous !== null &&
        !/^0(?:\.0+)?$/.test(change.previous) &&
        change.variation === null)
    )
      invalid();
  } else if (change.operation === 'RETIRO_OFERTA') {
    if (
      change.priceType !== 'OFERTA' ||
      change.previous === null ||
      change.next !== null ||
      change.variation !== null
    )
      invalid();
  } else invalid();
  return {
    ...(change.targetType === undefined
      ? {}
      : { targetType: change.targetType }),
    sku: change.sku,
    productId: change.productId,
    priceType: change.priceType,
    previous: change.previous,
    next: change.next,
    variation: change.variation,
    operation: change.operation,
    channel: change.channel,
    reason: change.reason,
    batchId: change.batchId,
    userId: change.userId,
    email: change.email,
    ip: change.ip,
    at: new Date(change.at),
  };
}
export function assertExportLimit(
  format: string,
  count: number,
): asserts format is 'CSV' | 'PDF' {
  if (
    !['CSV', 'PDF'].includes(format) ||
    !Number.isSafeInteger(count) ||
    count < 0
  )
    throw new AuditHttpError(400, 'VALIDACION');
  if (count > (format === 'CSV' ? 100000 : 500))
    throw new AuditHttpError(422, 'LIMITE_EXPORTACION_AUDITORIA_EXCEDIDO');
}
export function assertArchiveVerified(
  manifest: {
    recordCount: number;
    checksum: string;
    verifiedCount: number | null;
    verifiedChecksum: string | null;
    recoverable: boolean;
    verifiedAt: Date | null;
  },
  hotCount: number,
  hotChecksum: string,
): void {
  if (
    !manifest.verifiedAt ||
    !manifest.recoverable ||
    manifest.recordCount < 1 ||
    manifest.recordCount !== manifest.verifiedCount ||
    manifest.recordCount !== hotCount ||
    !manifest.checksum ||
    manifest.checksum !== manifest.verifiedChecksum ||
    manifest.checksum !== hotChecksum
  )
    throw new Error('Archivo no verificado; conservar originales.');
}
