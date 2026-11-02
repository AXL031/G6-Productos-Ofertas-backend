import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkReadinessService } from './health/bulk-readiness.service.js';
import { BulkImportService } from './bulk-import.service.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import { BulkUserBearerGuard } from './auth/bulk-user-bearer.guard.js';
import { BulkProblemFilter } from './http/bulk-problem.filter.js';
import { createBulkTemplateCsv, BULK_TEMPLATE_HEADERS } from './domain/bulk-template-v2.js';

describe('Bulk HTTP import routes (isolated)', () => {
  it('receives multipart CSV and returns contractual admission DTO; rejects unsupported files', async () => {
    const batch = { batchId: '11111111-1111-4111-8111-111111111111', status: 'QUEUED', templateVersion: 2, correlationId: '22222222-2222-4222-8222-222222222222', totalRows: 1, completedRows: 0, failedRows: 0, needsReconciliation: false };
    const rows = [{ row: { rowId: '33333333-3333-4333-8333-333333333333', status: 'FAILED', appliedDomains: ['CATALOGO'], failedDomain: 'PRICING', needsReconciliation: true, errorCode: 'PRICE_REJECTED', errorDetail: 'error estable' }, steps: [{ domain: 'CATALOGO', status: 'COMPLETED', errorCode: null, errorDetail: null }, { domain: 'PRICING', status: 'FAILED', errorCode: 'PRICE_REJECTED', errorDetail: 'error estable' }] }];
    const imports = {
      receiveImport: vi.fn().mockResolvedValue({ batch }),
      getSnapshot: vi.fn().mockResolvedValue({ batch: { ...batch, status: 'COMPLETED', failedRows: 1, needsReconciliation: true }, rows }),
      resumeBatch: vi.fn().mockResolvedValue(batch),
    };
    const storage = { put: vi.fn().mockResolvedValue('supabase://private/imports/test.csv') };
    const module = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [BulkSvcService, { provide: BulkImportService, useValue: imports }, { provide: BulkStorageService, useValue: storage }, { provide: BulkReadinessService, useValue: { check: vi.fn().mockResolvedValue(true) } }],
    }).overrideGuard(BulkUserBearerGuard).useValue({ canActivate: () => true }).compile();
    const app = module.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
    try {
      const template = await request(app.getHttpServer()).get('/carga-masiva/productos/plantilla?formato=CSV');
      expect(template.status).toBe(200);
      expect(template.text).toBe(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n`);
      expect((await request(app.getHttpServer()).get('/carga-masiva/productos/importaciones/unknown/private-proxy')).status).toBe(404);
      const csvValues = ['ALTA', '', '', 'SKU-BASE', '', 'Producto', 'Descripción', 'cat-1', 'marca-1', 'tipo-1', 'false', '10.50', '[]', '', '', '0'];
      const csv = Buffer.from(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n${csvValues.join(',')}\r\n`);
      const accepted = await request(app.getHttpServer()).post('/carga-masiva/productos/importaciones').field('template_version', '2').attach('archivo', csv, 'items.csv');
      expect(accepted.status).toBe(202);
      expect(accepted.body).toMatchObject({ batch_id: '11111111-1111-4111-8111-111111111111', status: 'QUEUED', template_version: 2 });
      const replay = await request(app.getHttpServer()).post('/carga-masiva/productos/importaciones').field('template_version', '2').attach('archivo', csv, 'items.csv');
      expect(replay.status).toBe(202);
      expect(storage.put).toHaveBeenCalledTimes(2);
      expect(imports.receiveImport.mock.calls[1]?.[0]).toMatchObject({ batchId: imports.receiveImport.mock.calls[0]?.[0].batchId, correlationId: imports.receiveImport.mock.calls[0]?.[0].correlationId });

      const status = await request(app.getHttpServer()).get(`/carga-masiva/productos/importaciones/${batch.batchId}`);
      expect(status.status).toBe(200);
      expect(status.body.rows[0]).toMatchObject({ status: 'FAILED', applied_domains: ['CATALOGO'], steps: [{ dominio: 'CATALOGO', status: 'COMPLETED' }, { dominio: 'PRICING', status: 'FAILED' }] });
      const report = await request(app.getHttpServer()).get(`/carga-masiva/productos/importaciones/${batch.batchId}/reporte`);
      expect(report.status).toBe(200);
      expect(report.text).toContain('PRICE_REJECTED');
      const resumed = await request(app.getHttpServer()).post(`/carga-masiva/productos/importaciones/${batch.batchId}/reanudar`);
      expect(resumed.status).toBe(202);
      expect(resumed.body).toMatchObject({ batch_id: batch.batchId, status: 'QUEUED', template_version: 2, correlation_id: batch.correlationId });

      const invalid = await request(app.getHttpServer()).post('/carga-masiva/productos/importaciones').field('template_version', '2').attach('archivo', createBulkTemplateCsv(), 'items.json');
      expect(invalid.status).toBe(422);
      expect(invalid.headers['content-type']).toContain('application/problem+json');
    } finally { await app.close(); }
  });
});
