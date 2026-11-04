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

const updateVariant = (n: number, skuBase: string, skuVariant: string) => ({
  ...row(n, skuBase),
  producto_id: 'product-1',
  product: { catalogVersion: 3 },
  variant: { catalogVersion: 2 },
  sku_variante: skuVariant,
});

const updateSimple = (n: number, skuBase: string, text = '') => ({
  ...row(n, skuBase, text),
  producto_id: `product-${skuBase}`,
  product: { catalogVersion: 3, nombre: text || `Producto ${n}` },
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

  it('preserves the exact v1 row shape and emits opaque SKU only as a v2 selector', () => {
    const [legacy] = buildCatalogBulkCommands({
      batchId: 'batch-v1',
      correlationId: 'correlation-v1',
      rows: [updateVariant(0, 'BASE', '000, ñ SKU')],
      occurredAt: new Date('2026-11-03T00:00:00.000Z'),
    });
    expect(legacy!.envelope.schema_version).toBe(1);
    expect(legacy!.envelope.data.rows[0]).not.toHaveProperty('sku_variante');

    const input = {
      batchId: 'batch-v2',
      correlationId: 'correlation-v2',
      rows: [updateVariant(0, 'BASE', '000, ñ SKU')],
      schemaVersion: 2 as const,
      occurredAt: new Date('2026-11-03T00:00:00.000Z'),
    };
    const [command] = buildCatalogBulkCommands(input);
    const [retry] = buildCatalogBulkCommands(input);
    expect(command).toEqual(retry);
    expect(command!.envelope.schema_version).toBe(2);
    expect(command!.envelope.data.template_version).toBe(2);
    expect(command!.envelope.data.rows[0]).toMatchObject({
      variant_id: null,
      sku_variante: '000, ñ SKU',
      product: { catalogVersion: 3 },
      variant: { catalogVersion: 2 },
    });
    expect(command!.envelope.data.rows[0]!.variant).not.toHaveProperty('sku');
  });

  it('rejects invalid v2 shapes and keeps v2 serialization inside the envelope limit', () => {
    expect(() =>
      buildCatalogBulkCommands({
        batchId: 'batch-v2-invalid',
        correlationId: 'correlation-v2-invalid',
        rows: [row(0, 'BASE')],
        schemaVersion: 2,
      }),
    ).toThrow(/schema_version 2/);
    const [command] = buildCatalogBulkCommands({
      batchId: 'batch-v2-size',
      correlationId: 'correlation-v2-size',
      rows: [updateVariant(0, 'BASE', 'SKU'.repeat(100))],
      schemaVersion: 2,
    });
    expect(Buffer.byteLength(command!.serialized, 'utf8')).toBeLessThanOrEqual(
      CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES,
    );
  });

  it.each([
    {
      rows: [
        updateSimple(0, 'SIMPLE-A'),
        updateVariant(1, 'VARIANT-B', 'SKU-B'),
      ],
    },
    {
      rows: [
        updateVariant(0, 'VARIANT-A', 'SKU-A'),
        updateSimple(1, 'SIMPLE-B'),
      ],
    },
  ])(
    'keeps mixed update families in v2 regardless of family order',
    ({ rows }) => {
      const input = {
        batchId: 'mixed-family-batch',
        correlationId: 'mixed-family-correlation',
        rows,
        schemaVersion: 2 as const,
        occurredAt: new Date('2026-11-03T00:00:00.000Z'),
      };
      const [command] = buildCatalogBulkCommands(input);
      const [replay] = buildCatalogBulkCommands(input);
      expect(command).toEqual(replay);
      expect(command!.envelope.schema_version).toBe(2);
      for (const item of command!.envelope.data.rows) {
        if (item.variant === null) expect(item.sku_variante).toBeUndefined();
        else expect(item.sku_variante).toBeTruthy();
      }
    },
  );

  it('keeps simple-only v2 chunks, all replay identities, size limit, and family boundaries stable', () => {
    const rows = [
      updateSimple(0, 'SIMPLE-A', 'ñ'.repeat(170_000)),
      updateSimple(1, 'SIMPLE-A', 'ñ'.repeat(170_000)),
      updateVariant(2, 'VARIANT-B', 'SKU-B'),
      updateSimple(3, 'SIMPLE-C', '界'.repeat(100_000)),
      updateSimple(4, 'SIMPLE-C', '界'.repeat(100_000)),
    ];
    const input = {
      batchId: 'mixed-chunk-batch',
      correlationId: 'mixed-chunk-correlation',
      rows,
      schemaVersion: 2 as const,
      occurredAt: new Date('2026-11-03T00:00:00.000Z'),
    };
    const commands = buildCatalogBulkCommands(input);
    const replay = buildCatalogBulkCommands(input);
    expect(commands).toEqual(replay);
    expect(commands.length).toBeGreaterThan(1);
    expect(
      commands.every(({ envelope }) => envelope.schema_version === 2),
    ).toBe(true);
    expect(
      commands.some(({ envelope }) =>
        envelope.data.rows.every((item) => item.variant === null),
      ),
    ).toBe(true);
    expect(
      commands.every(
        ({ serialized }) =>
          Buffer.byteLength(serialized, 'utf8') <=
          CATALOG_BULK_UPSERT_MAX_ENVELOPE_BYTES,
      ),
    ).toBe(true);
    const chunksByFamily = new Map<string, number>();
    commands.forEach(({ envelope }, chunkIndex) => {
      for (const family of new Set(
        envelope.data.rows.map((item) => item.sku_base),
      )) {
        expect(chunksByFamily.has(family)).toBe(false);
        chunksByFamily.set(family, chunkIndex);
      }
    });
    expect(commands.map(({ envelope }) => envelope.message_id)).toEqual(
      replay.map(({ envelope }) => envelope.message_id),
    );
    expect(commands.map(({ envelope }) => envelope.operation_id)).toEqual(
      replay.map(({ envelope }) => envelope.operation_id),
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
