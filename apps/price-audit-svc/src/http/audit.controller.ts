import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditRepository } from '../persistence/audit.repository.js';
import type { auditLog, exportJobs } from '../persistence/audit.schema.js';
import { uuid } from '../domain/audit.js';
import { parseFilters } from './audit-query.js';
import { AuditReadGuard, record } from './audit-read.guard.js';
import { AuditHttpError, AuditHttpFilter } from './audit-http.error.js';

export const AUDIT_EXPORT_WORKER = Symbol('AUDIT_EXPORT_WORKER');
export interface AuditExportWorker {
  supports(format: string): boolean;
  wake(): void;
  download(
    job: typeof exportJobs.$inferSelect,
  ): Promise<{ data: Buffer; contentType: 'text/csv' | 'application/pdf' }>;
}
function money(value: string | null) {
  if (value === null) return null;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new AuditHttpError(500, 'ERROR_INTERNO');
  // El contrato exige number; rawJSON conserva el decimal de PostgreSQL en el wire.
  return (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON(
    value,
  );
}
export function wireAudit(row: typeof auditLog.$inferSelect) {
  // OpenAPI rc.3 aun no admite SKU/canal nulos de DEC-G6-INT-06.
  if (row.sku === null || row.channel === null)
    throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
  return {
    id_auditoria: row.id,
    target_type: row.targetType,
    sku: row.sku,
    product_id: row.productId,
    tipo_precio: row.priceType,
    precio_anterior: money(row.previous),
    precio_nuevo: money(row.next),
    variacion_porcentual: money(row.variation),
    tipo_operacion: row.operation,
    canal_origen: row.channel,
    motivo_cambio: row.reason,
    batch_id: row.batchId,
    usuario_id: row.userId,
    usuario_email: row.email,
    ip_origen: row.ip,
    timestamp: row.at.toISOString(),
  };
}
function wireJob(job: typeof exportJobs.$inferSelect) {
  return {
    export_id: job.id,
    status: job.status,
    formato: job.format,
    created_at: job.createdAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
    // No exponer URIs privadas de almacenamiento.
    download_url: null,
  };
}
@Controller('api/v1/auditoria-precios')
@UseGuards(AuditReadGuard)
@UseFilters(AuditHttpFilter)
export class AuditController {
  constructor(
    @Inject(AuditRepository) private readonly repository: AuditRepository,
    @Optional()
    @Inject(AUDIT_EXPORT_WORKER)
    private readonly worker?: AuditExportWorker,
  ) {}
  @Get() async list(@Query() query: Record<string, unknown>) {
    const { filters, page, size } = parseFilters(query);
    const { items, total } = await this.repository.list(filters, page, size);
    return {
      items: items.map(wireAudit),
      meta: {
        pagina: page,
        tamanio: size,
        total,
        totalPaginas: Math.ceil(total / size),
      },
    };
  }
  @Post('exportaciones')
  @HttpCode(202)
  async createExport(
    @Body() body: unknown,
    @Req() request: Request & { auditActor?: string },
  ) {
    if (
      !record(body) ||
      typeof body.formato !== 'string' ||
      !['CSV', 'PDF'].includes(body.formato)
    )
      throw new AuditHttpError(400, 'VALIDACION');
    const query = Object.fromEntries(
      Object.entries(body).filter(([k, v]) => k !== 'formato' && v !== null),
    );
    const { filters } = parseFilters(query, false);
    if (!this.worker?.supports(String(body.formato)))
      throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    if (!request.auditActor) throw new AuditHttpError(401, 'TOKEN_INVALIDO');
    const job = await this.repository.createExport(
      filters,
      String(body.formato),
      request.auditActor,
    );
    await this.worker.wake();
    return wireJob(job);
  }
  @Get('exportaciones/:exportId') async exportJob(
    @Param('exportId') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (!uuid.test(id) || Object.keys(query).length)
      throw new AuditHttpError(400, 'VALIDACION');
    const job = await this.repository.exportJob(id);
    if (!job) throw new AuditHttpError(404, 'LOTE_NO_ENCONTRADO');
    return wireJob(job);
  }
  @Get('exportaciones/:exportId/archivo') async file(
    @Param('exportId') id: string,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ) {
    if (!uuid.test(id) || Object.keys(query).length)
      throw new AuditHttpError(400, 'VALIDACION');
    const job = await this.repository.exportJob(id);
    if (!job) throw new AuditHttpError(404, 'LOTE_NO_ENCONTRADO');
    if (!this.worker || job.status !== 'COMPLETED')
      throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    const file = await this.worker.download(job);
    if (
      file.contentType !==
      (job.format === 'CSV' ? 'text/csv' : 'application/pdf')
    )
      throw new AuditHttpError(500, 'ERROR_INTERNO');
    response
      .type(file.contentType)
      .setHeader(
        'Content-Disposition',
        `attachment; filename="auditoria-${job.id}.${job.format.toLowerCase()}"`,
      );
    response.send(file.data);
  }
  @Get(':auditId') async detail(
    @Param('auditId') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (!uuid.test(id) || Object.keys(query).length)
      throw new AuditHttpError(400, 'VALIDACION');
    const row = await this.repository.detail(id);
    if (!row) throw new AuditHttpError(404, 'AUDITORIA_PRECIO_NO_ENCONTRADA');
    return wireAudit(row);
  }
}
