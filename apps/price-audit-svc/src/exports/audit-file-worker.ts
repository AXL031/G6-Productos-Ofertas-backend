import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { PRICE_AUDIT_CONFIG, type AuditConfig } from '../config/environment.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import type { auditLog, exportJobs } from '../persistence/audit.schema.js';
import type { AuditExportWorker } from '../http/audit.controller.js';
import { AuditHttpError } from '../http/audit-http.error.js';
import { assertExportLimit, uuid } from '../domain/audit.js';

type Row = typeof auditLog.$inferSelect;
const maxBytes = 32 * 1024 * 1024;
const columns = [
  'id_auditoria',
  'sku',
  'product_id',
  'tipo_precio',
  'precio_anterior',
  'precio_nuevo',
  'variacion_porcentual',
  'tipo_operacion',
  'canal_origen',
  'motivo_cambio',
  'batch_id',
  'usuario_id',
  'usuario_email',
  'ip_origen',
  'timestamp',
  'target_type',
];
const values = (row: Row): string[] => [
  row.id,
  row.sku ?? '',
  row.productId,
  row.priceType,
  row.previous ?? 'Sin precio anterior',
  row.next ?? 'Sin oferta',
  row.variation ?? 'No aplicable',
  row.operation,
  row.channel ?? '',
  row.reason,
  row.batchId ?? '',
  row.userId ?? '',
  row.email ?? '',
  row.ip ?? '',
  row.at.toISOString(),
  row.targetType,
];

export function renderCsv(rows: Row[]): Buffer {
  assertExportLimit('CSV', rows.length);
  const escape = (value: string, index: number) =>
    '"' +
    (![4, 5, 6].includes(index) && /^[\s]*[=+\-@\t\r\n]/u.test(value)
      ? "'" + value
      : value
    ).replaceAll('"', '""') +
    '"';
  return Buffer.from(
    '\uFEFF' +
      [columns, ...rows.map(values)]
        .map((row) => row.map(escape).join(','))
        .join('\r\n') +
      '\r\n',
  );
}

export async function renderPdf(rows: Row[], font: string): Promise<Buffer> {
  assertExportLimit('PDF', rows.length);
  const document = new PDFDocument({
    size: 'A4',
    margin: 40,
    bufferPages: true,
    autoFirstPage: false,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes)
        document.destroy(new Error('Exportación demasiado grande.'));
      else chunks.push(chunk);
    });
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
  });
  // La fuente se configura explícitamente para conservar acentos y caracteres Unicode.
  try {
    document.registerFont('audit', font).font('audit');
    const heading = () => {
      document.addPage();
      document.fontSize(18).text('Productos y Ofertas');
      document.fontSize(14).text('Auditoría de precios').moveDown(0.6);
      document.fontSize(10).text(`${rows.length} registros`).moveDown();
    };
    heading();
    for (const [index, row] of rows.entries()) {
      const fields = values(row);
      document.fontSize(11);
      const title = `Registro ${index + 1}`;
      if (document.y + document.heightOfString(title) + 20 > 770) heading();
      document.text(title).moveDown(0.3);
      document.fontSize(9);
      for (const [i, value] of fields.entries()) {
        const text = `${columns[i]}: ${value || 'No informado'}`;
        // PDFKit continúa campos largos en páginas nuevas sin truncarlos.
        if (document.y + Math.min(document.heightOfString(text), 60) > 770)
          heading();
        document.fontSize(9).text(text);
      }
      document.moveDown();
    }
    const range = document.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      document.switchToPage(i);
      document.fontSize(8).text(`Página ${i + 1} de ${range.count}`, 40, 800, {
        lineBreak: false,
      });
    }
    document.end();
  } catch (error) {
    document.destroy(
      error instanceof Error ? error : new Error('PDF no disponible.'),
    );
  }
  return finished;
}

@Injectable()
export class AuditFileExportWorker
  implements AuditExportWorker, OnApplicationBootstrap, OnApplicationShutdown
{
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private closing = false;
  private readonly logger = new Logger(AuditFileExportWorker.name);
  constructor(
    @Inject(PRICE_AUDIT_CONFIG) private readonly config: AuditConfig,
    @Inject(AuditRepository) private readonly repository: AuditRepository,
  ) {}
  supports(format: string) {
    return Boolean(
      this.config.exportDirectory &&
      (format === 'CSV' || (format === 'PDF' && this.config.exportFont)),
    );
  }
  async ready() {
    if (!this.config.exportDirectory) return true;
    try {
      await access(
        this.config.exportDirectory,
        constants.R_OK | constants.W_OK,
      );
      if (this.config.exportFont)
        await access(this.config.exportFont, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
  async onApplicationBootstrap() {
    if (!this.config.exportDirectory) return;
    await mkdir(this.config.exportDirectory, { recursive: true, mode: 0o700 });
    await access(this.config.exportDirectory, constants.R_OK | constants.W_OK);
    if (this.config.exportFont)
      await access(this.config.exportFont, constants.R_OK);
    this.timer = setInterval(() => this.wake(), 3000);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.active || this.closing || !this.config.exportDirectory) return;
    this.active = this.run()
      .catch(() =>
        this.logger.warn(
          'Exportaciones de auditoría temporalmente no disponibles.',
        ),
      )
      .finally(() => {
        this.active = undefined;
      });
  }
  private async run() {
    for (let i = 0; i < 10 && !this.closing; i++) {
      if (
        !(await this.repository.processExport(async (job, rows) => {
          if (!this.supports(job.format))
            throw new Error('Formato no disponible.');
          const data =
            job.format === 'CSV'
              ? renderCsv(rows)
              : await renderPdf(rows, this.config.exportFont!);
          if (data.length > maxBytes)
            throw new Error('Exportación demasiado grande.');
          const path = this.path(job);
          const temporary = path + '.' + randomUUID() + '.tmp';
          try {
            await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
            await rename(temporary, path);
          } finally {
            await rm(temporary, { force: true });
          }
        }))
      )
        break;
    }
  }
  private path(job: typeof exportJobs.$inferSelect) {
    if (
      !this.config.exportDirectory ||
      !uuid.test(job.id) ||
      !['CSV', 'PDF'].includes(job.format)
    )
      throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    return join(
      this.config.exportDirectory,
      `${job.id}.${job.format.toLowerCase()}`,
    );
  }
  async download(job: typeof exportJobs.$inferSelect) {
    if (job.status !== 'COMPLETED')
      throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    try {
      if ((await stat(this.path(job))).size > maxBytes) throw new Error();
      const data = await readFile(this.path(job));
      if (data.length > maxBytes) throw new Error();
      return {
        data,
        contentType:
          job.format === 'CSV'
            ? ('text/csv' as const)
            : ('application/pdf' as const),
      };
    } catch {
      throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    }
  }
  async onApplicationShutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
