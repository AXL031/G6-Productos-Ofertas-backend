import { describe, expect, it, vi } from 'vitest';
import { BulkImportService } from './bulk-import.service.js';
import { BulkDomainError } from './domain/bulk.errors.js';
import { BULK_TEMPLATE_HEADERS } from './domain/bulk-template-v2.js';

describe('BulkImportService', () => {
  it('retains ALTA regular price when deriving required workflow domains', async () => {
    const createImportBatch = vi
      .fn()
      .mockResolvedValue({ batch: { status: 'QUEUED' } });
    const service = new BulkImportService({
      createImportBatch,
      findImportAdmissionIntent: vi.fn().mockResolvedValue(null),
    } as never);
    const values = [
      'ALTA',
      '',
      '',
      'SKU-1',
      '',
      'Producto',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'false',
      '12.5',
      '[]',
      '',
      '',
      '0',
    ];
    await service.receiveImport({
      bytes: Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.join(',')}\r\n`,
      ),
      format: 'CSV',
      templateVersion: 2,
      correlationId: '11111111-1111-4111-8111-111111111111',
      contentRef: 'private://stored',
    });
    expect(createImportBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            requiredDomains: ['CATALOGO', 'PRICING', 'INVENTARIO'],
          }),
        ],
      }),
    );
    expect(
      createImportBatch.mock.calls[0]?.[0].admissionIntent.rows[0].product
        .precioBaseInicial,
    ).toBe(12.5);
  });

  it('emits the approved v2 selector for variant ACTUALIZACION without a runtime flag', async () => {
    const createImportBatch = vi
      .fn()
      .mockResolvedValue({ batch: { status: 'QUEUED' } });
    const service = new BulkImportService({
      createImportBatch,
      findImportAdmissionIntent: vi.fn().mockResolvedValue(null),
    } as never);
    const values = [
      'ACTUALIZACION',
      '11111111-1111-4111-8111-111111111111',
      '0',
      'BASE',
      'VAR-LOOKUP',
      'Producto',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'true',
      '',
      '[]',
      '{"identificadores":[],"no_identificadores":[]}',
      '',
      '0',
    ];
    values[2] = '{"producto":0,"variante":0}';
    await service.receiveImport({
      bytes: Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
      ),
      format: 'CSV',
      templateVersion: 2,
      correlationId: '11111111-1111-4111-8111-111111111111',
      contentRef: 'private://stored',
    });
    expect(
      createImportBatch.mock.calls[0]?.[0].catalogCommands[0],
    ).toMatchObject({
      schemaVersion: 2,
      payload: {
        schema_version: 2,
        data: { rows: [{ sku_variante: 'VAR-LOOKUP' }] },
      },
    });
  });

  it('emits v2 for an enabled variant update from the real CSV parser', async () => {
    let persistedIntent: Record<string, unknown> | null = null;
    const createImportBatch = vi.fn(async (input: Record<string, unknown>) => {
      persistedIntent = input.admissionIntent as Record<string, unknown>;
      return { batch: { status: 'QUEUED' } };
    });
    const findImportAdmissionIntent = vi.fn(
      async () =>
        persistedIntent as
          (Record<string, unknown> & { catalogCommands: unknown[] }) | null,
    );
    const repository = {
      createImportBatch,
      findImportAdmissionIntent,
    } as never;
    const values = [
      'ACTUALIZACION',
      '11111111-1111-4111-8111-111111111111',
      '{"producto":3,"variante":2}',
      'BASE',
      '000, ñ SKU',
      'Producto',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'true',
      '',
      '[]',
      '{"identificadores":[],"no_identificadores":[]}',
      '',
      '0',
    ];
    const input = {
      bytes: Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
      ),
      format: 'CSV',
      templateVersion: 2,
      correlationId: '11111111-1111-4111-8111-111111111111',
      batchId: '33333333-3333-4333-8333-333333333333',
      contentRef: 'private://stored',
    } as const;
    const service = new BulkImportService(repository);
    await service.receiveImport(input);
    const admission = createImportBatch.mock.calls[0]?.[0];
    expect(admission.admissionIntent.catalogCommands[0]).toMatchObject({
      schema_version: 2,
      data: {
        template_version: 2,
        rows: [
          {
            producto_id: '11111111-1111-4111-8111-111111111111',
            variant_id: null,
            sku_variante: '000, ñ SKU',
            product: { catalogVersion: 3 },
            variant: { catalogVersion: 2 },
          },
        ],
      },
    });
    expect(
      admission.admissionIntent.catalogCommands[0].data.rows[0].variant,
    ).not.toHaveProperty('sku');
    const v2Payload = admission.admissionIntent.catalogCommands[0];
    const repeatService = new BulkImportService(repository);
    await repeatService.receiveImport(input);
    const replay =
      createImportBatch.mock.calls[1]?.[0].admissionIntent.catalogCommands[0];
    expect(replay).toEqual(v2Payload);
  });

  it('replays a persisted v1 command byte-for-byte for historical compatibility', async () => {
    const historical = {
      message_id: 'persisted-v1-message',
      schema_version: 1,
      occurred_at: '2026-10-01T00:00:00.000Z',
      correlation_id: '11111111-1111-4111-8111-111111111111',
      causation_id: null,
      operation_id: '22222222-2222-4222-8222-222222222222',
      producer: 'bulk-svc',
      kind: 'command',
      name: 'catalog.bulk.upsert.requested',
      data: {
        batch_id: '33333333-3333-4333-8333-333333333333',
        batch_operation_id: '22222222-2222-4222-8222-222222222222',
        template_version: 2,
        mode: 'ACTUALIZACION',
        rows: [
          {
            row_number: 2,
            row_operation_id: '44444444-4444-4444-8444-444444444444',
            producto_id: 'product-1',
            sku_base: 'BASE',
            product: { catalogVersion: 1 },
            variant_id: 'variant-1',
            variant: { catalogVersion: 1 },
          },
        ],
      },
    };
    const createImportBatch = vi
      .fn()
      .mockResolvedValue({ batch: { status: 'QUEUED' } });
    const service = new BulkImportService({
      createImportBatch,
      findImportAdmissionIntent: vi.fn().mockResolvedValue({
        catalogCommands: [historical],
      }),
    } as never);
    await service.createImport({
      batchId: '33333333-3333-4333-8333-333333333333',
      correlationId: '11111111-1111-4111-8111-111111111111',
      contentRef: 'private://stored',
      format: 'CSV',
      templateVersion: 2,
      rows: [
        {
          rowId: '44444444-4444-4444-8444-444444444444',
          productId: 'product-1',
          skuBase: 'BASE',
          variantSkus: ['SKU'],
          mode: 'ACTUALIZACION',
        },
      ],
    });
    const persisted =
      createImportBatch.mock.calls[0]?.[0].catalogCommands[0].payload;
    expect(persisted).toEqual(historical);
    expect(JSON.stringify(persisted)).toBe(JSON.stringify(historical));
  });

  it('persists validated normalized rows atomically through the repository', async () => {
    const createImportBatch = vi
      .fn()
      .mockResolvedValue({ batch: { status: 'QUEUED' } });
    const service = new BulkImportService({
      createImportBatch,
      findImportAdmissionIntent: vi.fn().mockResolvedValue(null),
    } as never);
    await expect(
      service.createImport({
        batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        contentRef: 'content://input/1',
        format: 'CSV',
        templateVersion: 2,
        rows: [
          {
            rowId: '11111111-1111-4111-8111-111111111111',
            productId: '22222222-2222-4222-8222-222222222222',
            skuBase: 'SKU-1',
            variantSkus: [],
          },
        ],
      }),
    ).resolves.toMatchObject({ batch: { status: 'QUEUED' } });
    expect(createImportBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        templateVersion: 2,
        rows: [
          {
            rowId: '11111111-1111-4111-8111-111111111111',
            requiredDomains: ['CATALOGO', 'INVENTARIO'],
          },
        ],
      }),
    );
  });

  it('rejects invalid requests before persistence is called', async () => {
    const createImportBatch = vi.fn();
    const service = new BulkImportService({
      createImportBatch,
      findImportAdmissionIntent: vi.fn().mockResolvedValue(null),
    } as never);
    await expect(
      service.createImport({
        batchId: 'batch',
        correlationId: 'corr',
        contentRef: 'ref',
        format: 'JSON',
        templateVersion: 2,
        rows: [],
      }),
    ).rejects.toBeInstanceOf(BulkDomainError);
    expect(createImportBatch).not.toHaveBeenCalled();
  });

  it('records a functional result through durable repository processing', async () => {
    const recordDomainResult = vi
      .fn()
      .mockResolvedValue({ processed: true, result: 'DOMAIN_COMPLETED' });
    const service = new BulkImportService({ recordDomainResult } as never);
    await expect(
      service.applyDomainResult({
        batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        rowId: '11111111-1111-4111-8111-111111111111',
        domain: 'CATALOGO',
        operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        messageId: 'catalog-result-1',
        correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        eventName: 'catalog.bulk.upsert.completed',
        action: 'UPSERT',
        status: 'COMPLETED',
      }),
    ).resolves.toEqual({ processed: true, result: 'DOMAIN_COMPLETED' });
    expect(recordDomainResult).toHaveBeenCalledOnce();
  });

  it('rejects malformed operation identities before persistence', async () => {
    const recordDomainResult = vi.fn();
    const service = new BulkImportService({ recordDomainResult } as never);
    await expect(
      service.applyDomainResult({
        batchId: 'batch',
        rowId: 'row',
        domain: 'CATALOGO',
        operationId: 'not-a-uuid',
        messageId: 'message',
        correlationId: 'correlation',
        eventName: 'catalog.bulk.upsert.completed',
        action: 'UPSERT',
        status: 'COMPLETED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(recordDomainResult).not.toHaveBeenCalled();
  });
});
