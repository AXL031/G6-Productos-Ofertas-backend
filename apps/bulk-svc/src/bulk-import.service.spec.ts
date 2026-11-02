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

  it('fails closed before persistence for variant ACTUALIZACION while Catalog lookup is unavailable', async () => {
    const createImportBatch = vi.fn();
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
    await expect(
      service.receiveImport({
        bytes: Buffer.from(
          `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
        ),
        format: 'CSV',
        templateVersion: 2,
        correlationId: '11111111-1111-4111-8111-111111111111',
        contentRef: 'private://stored',
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_PENDING' });
    expect(createImportBatch).not.toHaveBeenCalled();
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
