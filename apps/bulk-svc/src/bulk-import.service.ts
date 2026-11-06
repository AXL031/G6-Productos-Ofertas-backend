import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  buildCatalogBulkCommands,
  stableUuid,
  type CatalogBulkCommand,
  type CatalogBulkRow,
} from './messaging/catalog-bulk-upsert.js';
import {
  parseBulkTemplate,
  type ParsedBulkTemplate,
} from './domain/bulk-template-v2.js';
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
    parsed?: ParsedBulkTemplate;
  }) {
    if (input.templateVersion !== 2)
      throw new BulkDomainError(
        'PLANTILLA_INCOMPATIBLE',
        'template_version debe ser 2.',
      );
    const batchId = input.batchId ?? randomUUID();
    const parsedFile =
      input.parsed ?? parseBulkTemplate(input.bytes, input.format);
    const parsed = {
      ...parsedFile,
      rows: parsedFile.rows.map((row) => {
        const rowId = stableUuid(
          `${batchId}:bulk-row:${row.rowNumber}:${row.rowId}`,
        );
        return { ...row, rowId, rowOperationId: rowId };
      }),
    };
    const commandV2 =
      parsed.mode === 'ACTUALIZACION' &&
      parsed.rows.some((row) => row.variant !== null);
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
      batchId,
      correlationId: input.correlationId,
      contentRef: input.contentRef,
      format: input.format,
      templateVersion: parsed.templateVersion,
      rows,
      intentRows: parsed.rows,
      catalogCommandVersion: commandV2 ? 2 : 1,
    });
    return { ...result, parsed };
  }

  async getSnapshot(batchId: string) {
    const snapshot = await this.repository.loadBatchSnapshot(batchId);
    if (!snapshot)
      throw new BulkDomainError('BATCH_NOT_FOUND', 'El lote no existe.');
    return snapshot;
  }

  async createImport(input: {
    batchId: string;
    correlationId: string;
    contentRef: string;
    format: string;
    templateVersion: number;
    rows: NormalizedBulkRow[];
    intentRows?: unknown[];
    catalogCommandVersion?: 1 | 2;
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
    const catalogRows = (input.intentRows ?? []).map((value) => {
      if (typeof value !== 'object' || value === null) {
        throw new BulkDomainError(
          'INVALID_INPUT',
          'La intención normalizada de Catalog está incompleta.',
        );
      }
      const row = value as Record<string, unknown>;
      return {
        row_number: Number(row.rowNumber),
        row_operation_id: String(row.rowOperationId),
        producto_id: typeof row.productId === 'string' ? row.productId : null,
        sku_base: String(row.skuBase),
        product: row.product as Record<string, unknown>,
        variant_id: typeof row.variantId === 'string' ? row.variantId : null,
        variant: (row.variant as Record<string, unknown> | null) ?? null,
        ...(input.catalogCommandVersion === 2 &&
        typeof row.skuVariant === 'string'
          ? { sku_variante: row.skuVariant }
          : {}),
      } satisfies CatalogBulkRow;
    });
    let priorAdmission: Record<string, unknown> | null;
    try {
      priorAdmission = await this.repository.findImportAdmissionIntent(
        input.batchId,
      );
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
    const persistedCommands = Array.isArray(priorAdmission?.catalogCommands)
      ? priorAdmission.catalogCommands
      : null;
    const commands: CatalogBulkCommand[] = persistedCommands
      ? persistedCommands.map((value) => {
          const envelope = value as CatalogBulkCommand['envelope'];
          return { envelope, serialized: JSON.stringify(envelope) };
        })
      : catalogRows.length
        ? buildCatalogBulkCommands({
            batchId: input.batchId,
            correlationId: input.correlationId,
            rows: catalogRows,
            schemaVersion: input.catalogCommandVersion ?? 1,
            occurredAt: new Date(),
          })
        : [];
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
        catalogCommands: commands.map(({ envelope }) => ({
          messageId: envelope.message_id,
          eventName: envelope.name,
          kind: envelope.kind,
          schemaVersion: envelope.schema_version,
          correlationId: envelope.correlation_id,
          operationId: envelope.operation_id,
          occurredAt: new Date(envelope.occurred_at),
          payload: envelope as unknown as Record<string, unknown>,
        })),
        admissionIntent: {
          format: input.format,
          templateVersion: input.templateVersion,
          contentRef: input.contentRef,
          rows: input.intentRows ?? normalized,
          catalogCommands: commands.map(({ envelope }) => envelope),
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
        throw new BulkDomainError(
          'DEPENDENCY_PENDING',
          'El estado durable del lote no permite reanudación; consulte el snapshot antes de solicitar una nueva operación.',
          { cause: error },
        );
      }
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'NOT_CONFIGURED'
      ) {
        throw new BulkDomainError(
          'DEPENDENCY_PENDING',
          'BLOQUEADO_ESPECÍFICO: no existe un protocolo homologado que emita un nuevo intento para las filas fallidas; el estado durable se conserva.',
          { cause: error },
        );
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
