import { randomUUID } from 'node:crypto';
import { parseBulkRequest, canonicalBulk } from './catalog-bulk.service.js';
import type { CatalogEnvelope } from './catalog-messages.js';
function command(): CatalogEnvelope {
  const operation = randomUUID();
  return {
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: operation,
    producer: 'bulk-svc',
    kind: 'command',
    name: 'catalog.bulk.upsert.requested',
    data: {
      batch_id: randomUUID(),
      batch_operation_id: operation,
      template_version: 2,
      mode: 'ALTA',
      rows: [
        {
          row_number: 2,
          row_operation_id: randomUUID(),
          producto_id: null,
          sku_base: ' 000-SKU ',
          product: {},
          variant_id: null,
          variant: null,
        },
      ],
    },
  };
}
it('preserves opaque identities and accepts framing without replacing DTO validation', () => {
  const input = command();
  expect(parseBulkRequest(input).rows[0].sku_base).toBe(' 000-SKU ');
});
it.each(['template_version', 'mode', 'rows', 'batch_operation_id'])(
  'rejects invalid command framing: %s',
  (key) => {
    const input = command();
    input.data[key] = null;
    expect(() => parseBulkRequest(input)).toThrow();
  },
);
it('rejects duplicated row identities and numbers before effects', () => {
  const input = command(),
    rows = parseBulkRequest(input).rows;
  rows.push({ ...rows[0] });
  expect(() => parseBulkRequest(input)).toThrow();
  rows[1].row_number = 3;
  rows[1].row_operation_id = rows[0].row_operation_id.toUpperCase();
  expect(() => parseBulkRequest(input)).toThrow();
  rows[1].row_number = 2;
  rows[1].row_operation_id = randomUUID();
  expect(() => parseBulkRequest(input)).toThrow();
});
it('rejects noncontiguous families and envelopes exceeding 1 MiB', () => {
  const input = command(),
    rows = parseBulkRequest(input).rows;
  rows.push(
    {
      ...rows[0],
      sku_base: 'other',
      row_number: 3,
      row_operation_id: randomUUID(),
    },
    { ...rows[0], row_number: 4, row_operation_id: randomUUID() },
  );
  expect(() => parseBulkRequest(input)).toThrow();
  const large = command();
  parseBulkRequest(large).rows[0].product.nombre = 'x'.repeat(1048576);
  expect(() => parseBulkRequest(large)).toThrow();
});
it('requires update identity and distinguishes simple and variant update targets', () => {
  const input = command();
  input.data.mode = 'ACTUALIZACION';
  expect(() => parseBulkRequest(input)).toThrow();
  const rows = input.data.rows as Array<Record<string, unknown>>;
  rows[0].producto_id = 'opaque-id';
  expect(parseBulkRequest(input).mode).toBe('ACTUALIZACION');
  rows[0].variant = {};
  expect(() => parseBulkRequest(input)).toThrow();
  rows[0].variant_id = 'opaque-child';
  expect(parseBulkRequest(input).rows[0].variant_id).toBe('opaque-child');
});
it('canonicalizes object key order without conflating array order or opaque SKU values', () => {
  expect(canonicalBulk({ a: 1, b: 2 })).toBe(canonicalBulk({ b: 2, a: 1 }));
  expect(canonicalBulk(['0', '00'])).not.toBe(canonicalBulk(['00', '0']));
});
