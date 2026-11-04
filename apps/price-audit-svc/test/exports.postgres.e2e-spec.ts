import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PriceAuditSvcModule } from '../src/price-audit-svc.module.js';
import { AuditRepository } from '../src/persistence/audit.repository.js';
import {
  AuditFileExportWorker,
  renderCsv,
  renderPdf,
} from '../src/exports/audit-file-worker.js';
import { IsolatedAuditPostgres } from './isolated-postgres.js';
import { SignedUser } from './signed-user.js';
import type { AuditChange } from '../src/domain/audit.js';

describe.skipIf(process.env.PRICE_AUDIT_TEST_POSTGRES !== '1')(
  'Exportaciones reales, SQL aislado',
  () => {
    const database = new IsolatedAuditPostgres();
    const identity = new SignedUser();
    let directory: string;
    let app: INestApplication;
    let repository: AuditRepository;
    let worker: AuditFileExportWorker;
    const base = '/api/v1/auditoria-precios/exportaciones';
    const auth = () => 'Bearer ' + identity.token();
    const font = fileURLToPath(
      new URL('./fixtures/font/Abel-Regular.ttf', import.meta.url),
    );
    beforeAll(async () => {
      await database.start();
      await identity.start();
      directory = await mkdtemp(join(tmpdir(), 'vera-exports-'));
      const module = await Test.createTestingModule({
        imports: [
          PriceAuditSvcModule.forRoot({
            NODE_ENV: 'test',
            PORT: '3003',
            DATABASE_URL: database.runtimeUrl,
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: identity.issuer + '/jwks',
            AUDIT_EXPORT_DIRECTORY: directory,
            AUDIT_EXPORT_FONT: font,
          }),
        ],
      }).compile();
      app = module.createNestApplication({ logger: false });
      await app.init();
      repository = app.get(AuditRepository);
      worker = app.get(AuditFileExportWorker);
      await repository.append(
        { id: randomUUID(), correlationId: null, payload: { fixture: true } },
        [
          {
            sku: 'export-real',
            productId: 'product',
            priceType: 'REGULAR',
            operation: 'CREACION',
            previous: null,
            next: '0.00',
            variation: null,
            channel: 'GLOBAL',
            reason: '=HYPERLINK("evil")',
            batchId: null,
            userId: 'gestor',
            email: 'gestor@example.test',
            ip: null,
            at: new Date('2026-10-23T00:00:00Z'),
          },
        ],
      );
    }, 90000);
    afterAll(async () => {
      await app?.close();
      await identity.stop();
      await database.stop();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    const finish = async (id: string) => {
      await vi.waitFor(
        async () => {
          worker.wake();
          expect((await repository.exportJob(id))?.status).toBe('COMPLETED');
        },
        { timeout: 10000 },
      );
      return (await repository.exportJob(id))!;
    };
    it('genera CSV/PDF descargables, conserva cero/null, neutraliza fórmulas y no expone rutas privadas', async () => {
      for (const formato of ['CSV', 'PDF']) {
        const response = await request(app.getHttpServer())
          .post(base)
          .set('Authorization', auth())
          .send({ formato, sku: 'export-real' })
          .expect(202);
        expect(response.body.download_url).toBeNull();
        const job = await finish(response.body.export_id);
        expect(job.recordCount).toBe(1);
        const file = await worker.download(job);
        expect(file.contentType).toBe(
          formato === 'CSV' ? 'text/csv' : 'application/pdf',
        );
        await request(app.getHttpServer())
          .get(`${base}/${job.id}/archivo`)
          .expect(401);
        await request(app.getHttpServer())
          .get(`${base}/${job.id}/archivo`)
          .set(
            'Authorization',
            'Bearer ' + identity.token({ roles: ['COMPRADOR'] }),
          )
          .expect(403);
        const download = await request(app.getHttpServer())
          .get(`${base}/${job.id}/archivo`)
          .set('Authorization', auth())
          .expect(200);
        expect(download.headers['content-disposition']).toContain(
          `auditoria-${job.id}`,
        );
        if (formato === 'CSV') {
          const csv = file.data.toString('utf8');
          expect(csv).toContain('Sin precio anterior');
          expect(csv).toContain('"0.00"');
          expect(csv).toContain('No aplicable');
          expect(csv).toContain("'=HYPERLINK");
          expect(csv).not.toMatch(/currency|moneda/i);
        } else {
          expect(file.data.subarray(0, 5).toString()).toBe('%PDF-');
          expect(file.data.toString('latin1')).toContain('%%EOF');
          if (process.env.AUDIT_PDF_REVIEW_PATH)
            await writeFile(process.env.AUDIT_PDF_REVIEW_PATH, file.data);
        }
      }
    });
    it.each([
      { targetType: 'PRODUCTO' as const, sku: null, channel: 'MARKETPLACE' },
      { targetType: 'SKU' as const, sku: 'global-export', channel: null },
      { targetType: 'PRODUCTO' as const, sku: null, channel: null },
    ])(
      'exporta CSV/PDF con nulos sin depender de la proyeccion HTTP: %j',
      async (values) => {
        const batchId = randomUUID();
        const change: AuditChange = {
          ...values,
          productId: 'product-null',
          priceType: 'REGULAR',
          operation: 'CREACION',
          previous: null,
          next: '9007199254740993.0101',
          variation: null,
          reason: 'Ajuste',
          batchId,
          userId: null,
          email: null,
          ip: null,
          at: new Date(),
        };
        await repository.append(
          { id: randomUUID(), correlationId: null, payload: { fixture: true } },
          [change],
        );
        for (const formato of ['CSV', 'PDF']) {
          const response = await request(app.getHttpServer())
            .post(base)
            .set('Authorization', auth())
            .send({ formato, batchId })
            .expect(202);
          const job = await finish(response.body.export_id);
          expect(job.recordCount).toBe(1);
          const file = await worker.download(job);
          await request(app.getHttpServer())
            .get(`${base}/${job.id}/archivo`)
            .set('Authorization', auth())
            .expect(200);
          if (formato === 'CSV') {
            const csv = file.data.toString('utf8');
            expect(csv).toContain(
              '"' + (values.sku ?? '') + '","product-null"',
            );
            expect(csv).toContain('"9007199254740993.0101"');
            expect(csv).toContain(
              '"CREACION","' + (values.channel ?? '') + '","Ajuste"',
            );
            expect(csv).toContain('"' + values.targetType + '"\r\n');
            expect(csv).toContain('Sin precio anterior');
            expect(csv).toContain('No aplicable');
          } else {
            expect(file.data.subarray(0, 5).toString()).toBe('%PDF-');
            expect(file.data.toString('latin1')).toContain('%%EOF');
          }
        }
      },
    );
    it('revalida límites antes del archivo y termina FAILED_GENERAL ante cambios posteriores', async () => {
      const job = await repository.createExport(
        { sku: 'later' },
        'PDF',
        'gestor',
      );
      await repository.append(
        { id: randomUUID(), correlationId: null, payload: {} },
        Array.from({ length: 501 }, () => ({
          sku: 'later',
          productId: 'p',
          priceType: 'REGULAR' as const,
          operation: 'CREACION' as const,
          previous: null,
          next: '1',
          variation: null,
          channel: 'GLOBAL',
          reason: 'Alta',
          batchId: null,
          userId: null,
          email: null,
          ip: null,
          at: new Date(),
        })),
      );
      await vi.waitFor(
        async () => {
          worker.wake();
          expect((await repository.exportJob(job.id))?.status).toBe(
            'FAILED_GENERAL',
          );
        },
        { timeout: 10000 },
      );
      await expect(
        readFile(join(directory, `${job.id}.pdf`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('recupera trabajos PROCESSING y no acepta rutas ni estados ajenos al contrato', async () => {
      const job = await repository.createExport(
        { sku: 'export-real' },
        'CSV',
        'gestor',
      );
      await database.admin!.query(
        "UPDATE price_audit.export_jobs SET status='PROCESSING' WHERE id=$1",
        [job.id],
      );
      const completed = await finish(job.id);
      await expect(
        worker.download({ ...completed, id: '../../secret' }),
      ).rejects.toThrow();
      await rm(join(directory, `${job.id}.csv`));
      await expect(worker.download(completed)).rejects.toThrow();
    });
    it('renderiza sin truncar textos extensos y rechaza límites aun sin controlador', async () => {
      const { items } = await repository.list({ sku: 'export-real' }, 1, 20);
      const rows = Array.from({ length: 8 }, (_, i) => ({
        ...items[0],
        sku: `REG-${i}`,
        reason:
          'Revisión de catálogo y variación: ' +
          'Áéñ, descripción extensa. '.repeat(40),
      }));
      const pdf = await renderPdf(rows, font);
      expect(pdf.length).toBeGreaterThan(5000);
      if (process.env.AUDIT_PDF_REVIEW_PATH)
        await writeFile(
          process.env.AUDIT_PDF_REVIEW_PATH.replace('.pdf', '-multipagina.pdf'),
          pdf,
        );
      expect(() =>
        renderCsv(Array.from({ length: 100001 }, () => items[0])),
      ).toThrow();
      await expect(
        renderPdf(
          Array.from({ length: 501 }, () => items[0]),
          font,
        ),
      ).rejects.toThrow();
    });
  },
);
