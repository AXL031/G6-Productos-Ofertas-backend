import { randomUUID } from 'node:crypto';
import {
  parseBulkRequest,
  canonicalBulk,
  businessCode,
} from './catalog-bulk.service.js';
import type { CatalogEnvelope } from './catalog-messages.js';
import {
  parseCatalogMessage,
  InvalidCatalogMessage,
} from './catalog-messages.js';
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

describe('Bulk command version compatibility', () => {
  it.each([1, 2])(
    'accepts only the requested command at version %s without changing ALTA',
    (version) => {
      const input = command();
      input.schema_version = version;
      expect(parseCatalogMessage(input).schema_version).toBe(version);
      expect(parseBulkRequest(input).mode).toBe('ALTA');
    },
  );
  it.each([
    { sku_variante: ' 000,/ñ ' },
    { variant_id: 'opaque-child' },
    { sku_variante: ' 000,/ñ ', variant_id: 'opaque-child' },
    { sku_variante: ' 000,/ñ ', variant_id: null },
  ])(
    'v2 accepts selector %j while preserving the original row',
    (selectors) => {
      const input = command();
      input.schema_version = 2;
      input.data.mode = 'ACTUALIZACION';
      const row = (input.data.rows as Array<Record<string, unknown>>)[0];
      row.producto_id = 'parent';
      row.variant = { catalogVersion: 1 };
      delete row.variant_id;
      Object.assign(row, selectors);
      const before = canonicalBulk(input);
      expect(parseBulkRequest(input).rows[0]).toBe(row);
      expect(canonicalBulk(input)).toBe(before);
    },
  );
  it.each([
    {},
    { variant_id: null },
    { sku_variante: null },
    { sku_variante: '' },
    { sku_variante: 12 },
    { variant_id: '', sku_variante: 'valid' },
  ])('v2 rejects missing/malformed selectors %j', (selectors) => {
    const input = command();
    input.schema_version = 2;
    input.data.mode = 'ACTUALIZACION';
    const row = (input.data.rows as Array<Record<string, unknown>>)[0];
    row.producto_id = 'parent';
    row.variant = {};
    delete row.variant_id;
    Object.assign(row, selectors);
    expect(() => parseBulkRequest(input)).toThrow();
  });
  it('retains v1 strictness, v2 simple updates and all other message versions', () => {
    const input = command(),
      row = (input.data.rows as Array<Record<string, unknown>>)[0];
    row.sku_variante = null;
    expect(() => parseBulkRequest(input)).toThrow();
    input.schema_version = 2;
    input.data.mode = 'ACTUALIZACION';
    row.producto_id = 'parent';
    delete row.variant_id;
    delete row.sku_variante;
    expect(parseBulkRequest(input).rows[0].variant).toBeNull();
    row.sku_variante = 'not-simple';
    expect(() => parseBulkRequest(input)).toThrow();
    delete row.sku_variante;
    row.unknown = true;
    expect(() => parseBulkRequest(input)).toThrow();
    input.schema_version = 3;
    expect(() => parseCatalogMessage(input)).toThrow(InvalidCatalogMessage);
    input.schema_version = 2;
    expect(() =>
      parseCatalogMessage({
        ...input,
        name: 'taxonomy.category.updated',
        producer: 'taxonomy-svc',
        kind: 'event',
      }),
    ).toThrow(InvalidCatalogMessage);
    expect(() =>
      parseBulkRequest({ ...command(), schema_version: 3 }),
    ).toThrow();
  });
});

import { CatalogMutationService } from './catalog-mutation.service.js';
import { CatalogTransactionManager } from './catalog-transaction.js';
import { PostgresCatalogWriteRepository } from './postgres-catalog-write.repository.js';
import type { CatalogMasterClient } from './catalog-master.client.js';
import type { Database, CatalogTransaction } from './database.js';
import { CatalogPersistenceError } from './database-errors.js';

describe('Bulk business rejection classification', () => {
  it.each([
    ['uq_sku_identity_sku', 'SKU_DUPLICADO'],
    ['uq_products_sku_base', 'SKU_DUPLICADO'],
    ['uq_variants_sku', 'SKU_DUPLICADO'],
    ['uq_variants_product_combination', 'COMBINACION_DUPLICADA'],
    ['uq_products_slug', 'SLUG_DUPLICADO'],
  ])('classifies only the known UNIQUE %s as %s', (constraint, expected) => {
    expect(
      businessCode(new CatalogPersistenceError('unique', '23505', constraint)),
    ).toBe(expected);
    expect(
      businessCode(
        new CatalogPersistenceError('deferred_constraint', '23505', constraint),
      ),
    ).toBe(expected);
    const driver = Object.assign(new Error('private SQL'), {
      code: '23505',
      constraint,
    });
    expect(businessCode(new Error('query failed', { cause: driver }))).toBe(
      expected,
    );
  });

  it.each([
    'uq_outbox_message_id',
    'uq_inbox_message_handler',
    'uq_sku_identity_product',
    'uq_future_sku_rule',
    undefined,
  ])(
    'does not turn unknown or technical UNIQUE %s into SKU_DUPLICADO',
    (constraint) => {
      expect(
        businessCode(
          new CatalogPersistenceError('unique', '23505', constraint),
        ),
      ).toBeUndefined();
      expect(
        businessCode(
          new CatalogPersistenceError(
            'deferred_constraint',
            '23505',
            constraint,
          ),
        ),
      ).toBeUndefined();
    },
  );

  it('does not infer a duplicate from a constraint name without a UNIQUE violation', () => {
    expect(
      businessCode(
        new CatalogPersistenceError(
          'check',
          '23514',
          'uq_variants_product_combination',
        ),
      ),
    ).toBe('VALIDACION');
    expect(
      businessCode(
        new CatalogPersistenceError('connection', '08006', 'uq_products_slug'),
      ),
    ).toBeUndefined();
  });
});

it.each(['deadlock', 'serialization'] as const)(
  'keeps SQL %s retryable for Bulk while preserving the existing HTTP conflict',
  async (failure) => {
    const error = new CatalogPersistenceError(
      failure,
      failure === 'deadlock' ? '40P01' : '40001',
    );
    const boundary = {
      transaction: async () => {
        throw error;
      },
    };
    const mutations = new CatalogMutationService(
      new CatalogTransactionManager(boundary as unknown as Database),
      new PostgresCatalogWriteRepository(),
      {} as CatalogMasterClient,
      { resolve: async () => ({ slug: 'fixture', moneda: 'PEN' }) },
    );
    const input = {
      nombre: 'Fixture',
      descripcion: 'Disposable',
      categoriaId: 'c',
      marcaId: 'b',
      tipoProductoId: 't',
      precioBaseInicial: 20,
      skuBase: 'sku',
      tieneVariantes: false,
    };
    const actor = {
      authorization: 'Bearer fixture',
      correlationId: randomUUID(),
    };
    await expect(
      mutations.createProduct(
        input,
        actor,
        boundary as unknown as CatalogTransaction,
      ),
    ).rejects.toBe(error);
    await expect(mutations.createProduct(input, actor)).rejects.toMatchObject({
      status: 409,
    });
  },
);
