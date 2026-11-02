import { describe, expect, it } from 'vitest';
import {
  buildCatalogBulkCommands,
  CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES,
} from './catalog-bulk-upsert.js';

const row = (n: number, sku: string, text = '') => ({
  row_number: n + 2,
  row_operation_id: `row-${n}`,
  producto_id: null,
  sku_base: sku,
  product: { nombre: text || `Producto ${n}` },
  variant_id: null,
  variant: null,
});

describe('Catalog bulk upsert command construction', () => {
  it('keeps contiguous sku families in one chunk and identities stable on retry', () => {
    const input = {
      batchId: 'batch-1',
      correlationId: 'correlation-1',
      rows: [row(0, 'FAM-A'), row(1, 'FAM-A'), row(2, 'FAM-B')],
      occurredAt: new Date('2026-11-02T15:00:00.000Z'),
    };
    const first = buildCatalogBulkCommands(input);
    const retry = buildCatalogBulkCommands(input);
    expect(first).toEqual(retry);
    expect(first).toHaveLength(1);
    expect(first[0]!.envelope.data.rows.map((item) => item.sku_base)).toEqual([
      'FAM-A',
      'FAM-A',
      'FAM-B',
    ]);
  });

  it('chunks only at family boundaries and keeps each serialized envelope under 1 MiB', () => {
    const rows = [
      row(0, 'A', 'x'.repeat(400_000)),
      row(1, 'A', 'x'.repeat(400_000)),
      row(2, 'B', 'x'.repeat(400_000)),
    ];
    const commands = buildCatalogBulkCommands({
      batchId: 'batch-2',
      correlationId: 'correlation-2',
      rows,
    });
    expect(commands.length).toBeGreaterThan(1);
    expect(
      new Set(commands.map((command) => command.envelope.occurred_at)).size,
    ).toBe(1);
    expect(
      new Set(
        commands.map((command) => command.envelope.data.batch_operation_id),
      ).size,
    ).toBe(commands.length);
    expect(
      commands.every(
        (command) =>
          command.envelope.operation_id ===
          command.envelope.data.batch_operation_id,
      ),
    ).toBe(true);
    expect(
      commands.every(
        (command) =>
          Buffer.byteLength(command.serialized, 'utf8') <=
          CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES,
      ),
    ).toBe(true);
    expect(
      commands
        .flatMap((command) => command.envelope.data.rows)
        .map((item) => item.row_number),
    ).toEqual([2, 3, 4]);
    expect(
      commands.every(
        (command) =>
          !(
            command.envelope.data.rows[0]?.sku_base === 'A' &&
            command.envelope.data.rows.at(-1)?.sku_base === 'A' &&
            commands.some(
              (other) =>
                other !== command &&
                other.envelope.data.rows.some((item) => item.sku_base === 'A'),
            )
          ),
      ),
    ).toBe(true);
    const occurredAt = new Date('2026-11-02T15:00:00.000Z');
    const replay = buildCatalogBulkCommands({
      batchId: 'batch-2',
      correlationId: 'correlation-2',
      rows,
      occurredAt,
    });
    const firstAdmission = buildCatalogBulkCommands({
      batchId: 'batch-2',
      correlationId: 'correlation-2',
      rows,
      occurredAt,
    });
    expect(replay).toEqual(firstAdmission);
    expect(
      replay.every(
        (command) => command.envelope.occurred_at === occurredAt.toISOString(),
      ),
    ).toBe(true);
  });

  it('uses a current timestamp when a direct builder caller omits admission time', () => {
    const [command] = buildCatalogBulkCommands({
      batchId: 'batch-date',
      correlationId: 'correlation-date',
      rows: [row(0, 'A')],
    });
    expect(Date.parse(command!.envelope.occurred_at)).toBeGreaterThan(
      Date.parse('2000-01-01T00:00:00.000Z'),
    );
  });

  it('rejects a single family that cannot fit without splitting it', () => {
    expect(() =>
      buildCatalogBulkCommands({
        batchId: 'batch-3',
        correlationId: 'correlation-3',
        rows: [row(0, 'A', 'x'.repeat(CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES))],
      }),
    ).toThrow(/familia sku_base/);
  });
});
