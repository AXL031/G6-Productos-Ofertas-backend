import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { parseBulkTemplate } from './domain/bulk-template-v2.js';
import {
  BulkDomainError,
  mapBulkPersistenceError,
} from './domain/bulk.errors.js';
import {
  validateBulkImport,
  type NormalizedBulkRow,
} from './domain/bulk.validation.js';
import { BulkPersistenceError } from './persistence/bulk.persistence.errors.js';
import {
  BulkPersistenceRepository,
  type DomainResultInput,
} from './persistence/bulk.repository.js';

@Injectable()
export class BulkImportService {
  constructor(private readonly repository: BulkPersistenceRepository) {}

  async receiveImport(input: {
    bytes: Buffer;
    format: 'CSV' | 'XLSX';
    templateVersion: number;
    correlationId: string;
    contentRef: string;
    batchId?: string;
  }) {
    if (input.templateVersion !== 2)
      throw new BulkDomainError(
        'PLANTILLA_INCOMPATIBLE',
        'template_version debe ser 2.',
      );
    const parsed = parseBulkTemplate(input.bytes, input.format);
    assertImportDependencies(parsed);
    const rows: NormalizedBulkRow[] = parsed.rows.map((row) => ({
      rowId: row.rowId,
      productId: row.productId,
      mode: row.mode,
      skuIdentityRequired: true,
      skuBase: row.skuBase,
      variantSkus: row.skuVariant ? [row.skuVariant] : [],
      precioRegular:
        typeof row.product.precioBaseInicial === 'number'
          ? row.product.precioBaseInicial
          : null,
      stockInicial: row.stockInicial,
      defaultLocationId: row.defaultLocationId,
    }));
    const result = await this.createImport({
      batchId: input.batchId ?? randomUUID(),
      correlationId: input.correlationId,
      contentRef: input.contentRef,
      format: input.format,
      templateVersion: parsed.templateVersion,
      rows,
      intentRows: parsed.rows,
    });
    return { ...result, parsed };
  }

  async getSnapshot(batchId: string) {
    const batch = await this.repository.findBatchByBatchId(batchId);
    if (!batch)
      throw new BulkDomainError('BATCH_NOT_FOUND', 'El lote no existe.');
    const rows = await this.repository.listBatchRows(batchId);
    return {
      batch,
      rows: await Promise.all(
        rows.map(async (row) => ({
          row,
          steps: await this.repository.listRowSteps(batchId, row.rowId),
        })),
      ),
    };
  }

  async createImport(input: {
    batchId: string;
    correlationId: string;
    contentRef: string;
    format: string;
    templateVersion: number;
    rows: NormalizedBulkRow[];
    intentRows?: unknown[];
  }) {
    const normalized = validateBulkImport(input);
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      !uuid.test(input.batchId) ||
      !uuid.test(input.correlationId) ||
      !input.contentRef
    ) {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'batch_id, correlation_id o referencia del archivo son inválidos.',
      );
    }
    const persistedRows = normalized.map((row) => ({
      rowId: row.rowId,
      requiredDomains: row.requiredDomains,
    }));
    try {
      return await this.repository.createImportBatch({
        batchId: input.batchId,
        correlationId: input.correlationId,
        templateVersion: input.templateVersion,
        inputFile: {
          format: input.format as 'CSV' | 'XLSX',
          contentRef: input.contentRef,
        },
        rows: persistedRows,
        admissionIntent: {
          format: input.format,
          templateVersion: input.templateVersion,
          contentRef: input.contentRef,
          rows: input.intentRows ?? normalized,
        },
      });
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
  }

  async applyDomainResult(input: DomainResultInput) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.operationId,
      )
    ) {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'operation_id tiene formato inválido.',
      );
    }
    if (!input.messageId || !input.correlationId || !input.eventName) {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'El resultado no contiene su identidad técnica completa.',
      );
    }
    try {
      return await this.repository.recordDomainResult(input);
    } catch (error) {
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'CHECK_VIOLATION'
      ) {
        throw new BulkDomainError('INVALID_TRANSITION', error.message, {
          cause: error,
        });
      }
      throw mapBulkPersistenceError(error);
    }
  }

  async resumeBatch(batchId: string) {
    try {
      return await this.repository.requeueBatch(batchId);
    } catch (error) {
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'FOREIGN_KEY_VIOLATION'
      ) {
        throw new BulkDomainError('BATCH_NOT_FOUND', 'El lote no existe.', {
          cause: error,
        });
      }
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'CHECK_VIOLATION'
      ) {
        throw new BulkDomainError('INVALID_TRANSITION', error.message, {
          cause: error,
        });
      }
      throw mapBulkPersistenceError(error);
    }
  }
}

export function assertImportDependencies(
  parsed: ReturnType<typeof parseBulkTemplate>,
): void {
  if (
    parsed.mode === 'ACTUALIZACION' &&
    parsed.rows.some((row) => row.variant !== null)
  ) {
    throw new BulkDomainError(
      'DEPENDENCY_PENDING',
      'BLOQUEADO_ESPECÍFICO: ACTUALIZACION de variantes requiere resolver sku_variante a variant_id mediante la lectura autorizada de Catalog.',
    );
  }
}
