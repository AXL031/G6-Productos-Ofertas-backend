import { createHash } from 'node:crypto';

export const CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES = 1_048_576;
export const CATALOG_BULK_UPSERT_ROUTING_KEY = 'catalog.bulk.upsert.requested';

export interface CatalogBulkRow {
  row_number: number;
  row_operation_id: string;
  producto_id: string | null;
  sku_base: string;
  product: Record<string, unknown>;
  variant_id: string | null;
  variant: Record<string, unknown> | null;
  sku_variante?: string;
}

export interface CatalogBulkEnvelope {
  message_id: string;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id: string | null;
  operation_id: string;
  producer: 'bulk-svc';
  kind: 'command';
  name: typeof CATALOG_BULK_UPSERT_ROUTING_KEY;
  data: {
    batch_id: string;
    batch_operation_id: string;
    template_version: 2;
    mode: 'ALTA' | 'ACTUALIZACION';
    rows: CatalogBulkRow[];
  };
}

export interface CatalogBulkCommand {
  envelope: CatalogBulkEnvelope;
  serialized: string;
}

export function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidOrStable(batchId: string, purpose: string): string {
  return stableUuid(`${batchId}:${purpose}`);
}

function encode(envelope: CatalogBulkEnvelope): string {
  return JSON.stringify(envelope);
}

function fits(envelope: CatalogBulkEnvelope): boolean {
  return (
    Buffer.byteLength(encode(envelope), 'utf8') <=
    CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES
  );
}

/** Splits only between contiguous sku_base families; identities are deterministic across retries. */
export function buildCatalogBulkCommands(input: {
  batchId: string;
  correlationId: string;
  rows: CatalogBulkRow[];
  schemaVersion?: 1 | 2;
  occurredAt?: Date;
}): CatalogBulkCommand[] {
  if (input.rows.length === 0) return [];
  const commandInput = {
    ...input,
    schemaVersion: input.schemaVersion ?? 1,
    occurredAt: input.occurredAt ?? new Date(),
  };
  const groups: CatalogBulkRow[][] = [];
  for (const row of input.rows) {
    const previous = groups.at(-1);
    if (previous?.at(-1)?.sku_base === row.sku_base) previous.push(row);
    else groups.push([row]);
  }

  const chunks: CatalogBulkRow[][] = [];
  let current: CatalogBulkRow[] = [];
  for (const family of groups) {
    const candidate = [...current, ...family];
    if (
      current.length > 0 &&
      !fits(makeEnvelope(commandInput, candidate, chunks.length))
    ) {
      chunks.push(current);
      current = [];
    }
    const familyEnvelope = makeEnvelope(
      commandInput,
      [...current, ...family],
      chunks.length,
    );
    if (!fits(familyEnvelope))
      throw new Error(
        'Una familia sku_base excede el máximo contractual de 1 MiB.',
      );
    current.push(...family);
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((rows, index) => {
    const envelope = makeEnvelope(commandInput, rows, index);
    const serialized = encode(envelope);
    if (
      Buffer.byteLength(serialized, 'utf8') >
      CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES
    ) {
      throw new Error(
        'El envelope catalog.bulk.upsert.requested excede 1 MiB.',
      );
    }
    return { envelope, serialized };
  });
}

function makeEnvelope(
  input: {
    batchId: string;
    correlationId: string;
    rows: CatalogBulkRow[];
    schemaVersion: 1 | 2;
    occurredAt?: Date;
  },
  rows: CatalogBulkRow[],
  index: number,
): CatalogBulkEnvelope {
  const mode =
    rows[0]?.product && 'catalogVersion' in rows[0].product
      ? 'ACTUALIZACION'
      : 'ALTA';
  if (
    rows.some(
      (row) => 'catalogVersion' in row.product !== (mode === 'ACTUALIZACION'),
    )
  ) {
    throw new Error(
      'Un comando Catalog no puede mezclar modos ALTA y ACTUALIZACION.',
    );
  }
  if (
    input.schemaVersion === 2 &&
    (mode !== 'ACTUALIZACION' ||
      rows.some((row) => row.variant !== null && !row.sku_variante))
  ) {
    throw new Error(
      'schema_version 2 requiere ACTUALIZACION y sku_variante para cada variante.',
    );
  }
  const serializedRows = rows.map((row) => {
    if (input.schemaVersion !== 2 || row.variant === null) {
      const legacyRow = { ...row };
      delete legacyRow.sku_variante;
      return legacyRow;
    }
    const { sku_variante, ...rowWithoutSelector } = row;
    return { ...rowWithoutSelector, sku_variante };
  });
  return {
    message_id: uuidOrStable(
      input.batchId,
      `catalog-bulk-upsert:${index}:message`,
    ),
    schema_version: input.schemaVersion,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    correlation_id: input.correlationId,
    causation_id: null,
    operation_id: uuidOrStable(
      input.batchId,
      `catalog-bulk-upsert:${index}:operation`,
    ),
    producer: 'bulk-svc',
    kind: 'command',
    name: CATALOG_BULK_UPSERT_ROUTING_KEY,
    data: {
      batch_id: input.batchId,
      batch_operation_id: uuidOrStable(
        input.batchId,
        `catalog-bulk-upsert:${index}:operation`,
      ),
      template_version: 2,
      mode,
      rows: serializedRows,
    },
  };
}
