import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Res,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Body,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkReadinessService } from './health/bulk-readiness.service.js';
import { BulkImportService } from './bulk-import.service.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import { BulkUserBearerGuard } from './auth/bulk-user-bearer.guard.js';
import { BulkExportService } from './bulk-export.service.js';
import {
  createBulkTemplateCsv,
  createBulkTemplateXlsx,
  parseBulkTemplate,
} from './domain/bulk-template-v2.js';
import { BulkDomainError } from './domain/bulk.domain-error.js';

@Controller()
export class BulkSvcController {
  constructor(
    private readonly service: BulkSvcService,
    private readonly readiness: BulkReadinessService,
    private readonly imports: BulkImportService,
    private readonly storage: BulkStorageService,
    private readonly exports: BulkExportService,
  ) {}

  @Get('health') getHealth() {
    return this.service.getHealth();
  }

  @Get('health/readiness') async getReadiness(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const result = await this.readiness.probe(request.socket.remoteAddress);
    return response
      .status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        status: result.ready ? 'ready' : 'not_ready',
        service: 'bulk-svc',
        reason: result.reason,
      });
  }

  @UseGuards(BulkUserBearerGuard)
  @Get('api/v1/carga-masiva/productos/plantilla')
  descargarPlantillaProductos(
    @Query('formato') format: string,
    @Res() response: Response,
  ) {
    if (format !== 'CSV' && format !== 'XLSX')
      throw new BadRequestException('VALIDACION');
    const bytes =
      format === 'CSV' ? createBulkTemplateCsv() : createBulkTemplateXlsx();
    response.setHeader(
      'Content-Type',
      format === 'CSV'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="plantilla-productos-v2.${format.toLowerCase()}"`,
    );
    return response.status(200).send(bytes);
  }

  @UseGuards(BulkUserBearerGuard)
  @Post('api/v1/carga-masiva/productos/importaciones')
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('archivo', {
      limits: {
        fileSize: 10_485_760,
        files: 1,
        fields: 2,
        fieldSize: 64,
        parts: 3,
      },
    }),
  )
  async crearImportacionGeneralProductos(
    @UploadedFile()
    file:
      { buffer: Buffer; originalname: string; mimetype: string } | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Res() response: Response,
  ) {
    if (!file) throw new BadRequestException('ARCHIVO_INVALIDO');
    const extension = file.originalname.toLowerCase().split('.').pop();
    const format =
      extension === 'csv' ? 'CSV' : extension === 'xlsx' ? 'XLSX' : null;
    if (!format)
      throw new BulkDomainError(
        'PLANTILLA_INCOMPATIBLE',
        'El archivo debe ser CSV o XLSX.',
      );
    const rawVersion = (
      response.req as typeof response.req & { body?: Record<string, unknown> }
    ).body?.template_version;
    const version =
      rawVersion === undefined ? 2 : rawVersion === '2' ? 2 : null;
    if (version === null)
      throw new BulkDomainError(
        'PLANTILLA_INCOMPATIBLE',
        'template_version debe ser 2 cuando se informa.',
      );
    const contentHash = createHash('sha256').update(file.buffer).digest('hex');
    const correlationId =
      correlation &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        correlation,
      )
        ? correlation
        : uuidFromDigest(
            createHash('sha256')
              .update(correlation ?? contentHash)
              .digest('hex'),
          );
    const parsed = parseBulkTemplate(file.buffer, format);
    const batchId = uuidFromDigest(
      createHash('sha256')
        .update(`${correlationId}:${contentHash}`)
        .digest('hex'),
    );
    const contentRef = await this.storage.put(
      file.buffer,
      file.mimetype,
      `imports/${batchId}/${contentHash}.${extension}`,
    );
    const result = await this.imports.receiveImport({
      bytes: file.buffer,
      format,
      templateVersion: version,
      correlationId,
      contentRef,
      batchId,
      parsed,
    });
    return response.status(202).json({
      batch_id: result.batch.batchId,
      status: 'QUEUED',
      template_version: result.batch.templateVersion,
      correlation_id: result.batch.correlationId,
    });
  }

  @UseGuards(BulkUserBearerGuard)
  @Get('api/v1/carga-masiva/productos/importaciones/:batchId')
  async obtenerImportacionGeneralProductos(@Param('batchId') batchId: string) {
    assertBatchId(batchId);
    const { batch, rows } = await this.imports.getSnapshot(batchId);
    return {
      batch_id: batch.batchId,
      status: batch.status,
      total_rows: batch.totalRows,
      completed_rows: batch.completedRows,
      failed_rows: batch.failedRows,
      needs_reconciliation: batch.needsReconciliation,
      rows: rows.map(({ row, steps }) => ({
        row_id: row.rowId,
        status: row.status,
        applied_domains: row.appliedDomains,
        failed_domain: row.failedDomain,
        needs_reconciliation: row.needsReconciliation,
        code: row.errorCode,
        detail: row.errorDetail,
        steps: steps.map((step) => ({
          dominio: step.domain,
          status: step.status,
          code: step.errorCode,
          detail: step.errorDetail,
        })),
      })),
    };
  }

  @UseGuards(BulkUserBearerGuard)
  @Get('api/v1/carga-masiva/productos/importaciones/:batchId/reporte')
  async descargarReporteImportacionGeneral(
    @Param('batchId') batchId: string,
    @Res() response: Response,
  ) {
    assertBatchId(batchId);
    const { rows } = await this.imports.getSnapshot(batchId);
    const failed = rows.filter(({ row }) => row.status === 'FAILED');
    const quote = (value: unknown) =>
      `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      'row_id,status,failed_domain,code,detail',
      ...failed.map(({ row }) =>
        [
          row.rowId,
          row.status,
          row.failedDomain,
          row.errorCode,
          row.errorDetail,
        ]
          .map(quote)
          .join(','),
      ),
    ];
    return response
      .status(200)
      .type('text/csv')
      .send(`${lines.join('\r\n')}\r\n`);
  }

  @UseGuards(BulkUserBearerGuard)
  @Post('api/v1/carga-masiva/productos/importaciones/:batchId/reanudar')
  @HttpCode(202)
  async reanudarImportacionGeneral(@Param('batchId') batchId: string) {
    assertBatchId(batchId);
    const batch = await this.imports.resumeBatch(batchId);
    return {
      batch_id: batch.batchId,
      status: batch.status,
      template_version: batch.templateVersion,
      correlation_id: batch.correlationId,
    };
  }

  @UseGuards(BulkUserBearerGuard)
  @Post('api/v1/carga-masiva/productos/exportaciones')
  @HttpCode(202)
  async crearExportacionGeneralProductos(@Body() body: { formato?: unknown }) {
    return this.exports.create(body?.formato as 'CSV' | 'XLSX');
  }

  @UseGuards(BulkUserBearerGuard)
  @Get('api/v1/carga-masiva/productos/exportaciones/:exportId')
  async obtenerExportacionGeneralProductos(
    @Param('exportId') exportId: string,
  ) {
    return this.exports.get(exportId);
  }

  @UseGuards(BulkUserBearerGuard)
  @Get('api/v1/carga-masiva/productos/exportaciones/:exportId/archivo')
  async descargarExportacionGeneralProductos(
    @Param('exportId') exportId: string,
    @Res() response: Response,
  ) {
    const { job, manifest } = await this.exports.download(exportId);
    const bytes = await this.storage.get(manifest.contentRef);
    response.setHeader(
      'Content-Type',
      job.format === 'CSV'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="exportacion-productos-${job.exportId}.${job.format.toLowerCase()}"`,
    );
    return response.status(200).send(bytes);
  }
}

function assertBatchId(batchId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      batchId,
    )
  ) {
    throw new BulkDomainError('BATCH_NOT_FOUND', 'El lote no existe.');
  }
}

function uuidFromDigest(digest: string): string {
  const value = `${digest.slice(0, 12)}4${digest.slice(13, 16)}8${digest.slice(17, 20)}${digest.slice(20, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
