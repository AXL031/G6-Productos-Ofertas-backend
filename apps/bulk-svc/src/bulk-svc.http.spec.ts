import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkReadinessService } from './health/bulk-readiness.service.js';
import { BulkImportService } from './bulk-import.service.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import { BulkExportService } from './bulk-export.service.js';
import { BulkDomainError } from './domain/bulk.domain-error.js';
import { BulkUserBearerGuard } from './auth/bulk-user-bearer.guard.js';
import { BulkProblemFilter } from './http/bulk-problem.filter.js';
import {
  createBulkTemplateCsv,
  BULK_TEMPLATE_HEADERS,
} from './domain/bulk-template-v2.js';

describe('Bulk HTTP import routes (isolated)', () => {
  it('receives multipart CSV and returns contractual admission DTO; rejects unsupported files', async () => {
    const batch = {
      batchId: '11111111-1111-4111-8111-111111111111',
      status: 'QUEUED',
      templateVersion: 2,
      correlationId: '22222222-2222-4222-8222-222222222222',
      totalRows: 1,
      completedRows: 0,
      failedRows: 0,
      needsReconciliation: false,
    };
    const rows = [
      {
        row: {
          rowId: '33333333-3333-4333-8333-333333333333',
          status: 'FAILED',
          appliedDomains: ['CATALOGO'],
          failedDomain: 'PRICING',
          needsReconciliation: true,
          errorCode: 'PRICE_REJECTED',
          errorDetail: 'error estable',
        },
        steps: [
          {
            domain: 'CATALOGO',
            status: 'COMPLETED',
            errorCode: null,
            errorDetail: null,
          },
          {
            domain: 'PRICING',
            status: 'FAILED',
            errorCode: 'PRICE_REJECTED',
            errorDetail: 'error estable',
          },
        ],
      },
    ];
    const imports = {
      receiveImport: vi.fn().mockResolvedValue({ batch }),
      getSnapshot: vi.fn().mockResolvedValue({
        batch: {
          ...batch,
          status: 'COMPLETED',
          failedRows: 1,
          needsReconciliation: true,
        },
        rows,
      }),
      resumeBatch: vi.fn().mockResolvedValue(batch),
    };
    const storage = {
      put: vi.fn().mockResolvedValue('supabase://private/imports/test.csv'),
    };
    const module = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [
        BulkSvcService,
        { provide: BulkImportService, useValue: imports },
        { provide: BulkStorageService, useValue: storage },
        {
          provide: BulkExportService,
          useValue: {
            create: vi.fn(async (format: string) => {
              if (format !== 'CSV' && format !== 'XLSX')
                throw new BulkDomainError('INVALID_INPUT', 'bad format');
              return {
                export_id: '44444444-4444-4444-8444-444444444444',
                status: 'QUEUED',
                formato: format,
              };
            }),
            get: vi.fn(async (id: string) => {
              if (id === 'not-a-uuid')
                throw new BulkDomainError('EXPORT_NOT_FOUND', 'missing');
              return {
                export_id: id,
                status: 'FAILED_GENERAL',
                formato: 'CSV',
              };
            }),
            download: vi
              .fn()
              .mockRejectedValue(
                new BulkDomainError('EXPORT_NOT_READY', 'not ready'),
              ),
          },
        },
        {
          provide: BulkReadinessService,
          useValue: { check: vi.fn().mockResolvedValue(true) },
        },
      ],
    })
      .overrideGuard(BulkUserBearerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = module.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
    try {
      const template = await request(app.getHttpServer()).get(
        '/api/v1/carga-masiva/productos/plantilla?formato=CSV',
      );
      expect(template.status).toBe(200);
      expect(template.text).toBe(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n`);
      const badFormat = await request(app.getHttpServer()).get(
        '/api/v1/carga-masiva/productos/plantilla?formato=TXT',
      );
      expect(badFormat.status).toBe(400);
      expect(badFormat.body).toMatchObject({ code: 'VALIDACION', status: 400 });
      expect(
        (
          await request(app.getHttpServer()).post(
            '/api/v1/carga-masiva/productos/plantilla',
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/importaciones',
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/importaciones/not-a-uuid',
          )
        ).body,
      ).toMatchObject({ code: 'LOTE_NO_ENCONTRADO', status: 404 });
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/importaciones/unknown/private-proxy',
          )
        ).status,
      ).toBe(404);
      const csvValues = [
        'ALTA',
        '',
        '',
        'SKU-BASE',
        '',
        'Producto',
        'Descripción',
        'cat-1',
        'marca-1',
        'tipo-1',
        'false',
        '10.50',
        '[]',
        '',
        '',
        '0',
      ];
      const csv = Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${csvValues.join(',')}\r\n`,
      );
      const accepted = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '2')
        .attach('archivo', csv, 'items.csv');
      expect(accepted.status).toBe(202);
      expect(accepted.body).toMatchObject({
        batch_id: '11111111-1111-4111-8111-111111111111',
        status: 'QUEUED',
        template_version: 2,
      });
      const replay = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '2')
        .attach('archivo', csv, 'items.csv');
      expect(replay.status).toBe(202);
      expect(storage.put).toHaveBeenCalledTimes(2);
      expect(imports.receiveImport.mock.calls[1]?.[0]).toMatchObject({
        batchId: imports.receiveImport.mock.calls[0]?.[0].batchId,
        correlationId: imports.receiveImport.mock.calls[0]?.[0].correlationId,
      });
      const withoutVersion = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .attach('archivo', csv, 'items.csv');
      expect(withoutVersion.status).toBe(202);
      expect(imports.receiveImport.mock.calls[2]?.[0].templateVersion).toBe(2);
      const wrongVersion = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '1')
        .attach('archivo', csv, 'items.csv');
      expect(wrongVersion.status).toBe(422);
      expect(wrongVersion.body).toMatchObject({
        code: 'PLANTILLA_INCOMPATIBLE',
        status: 422,
      });

      const status = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/importaciones/${batch.batchId}`,
      );
      expect(status.status).toBe(200);
      expect(status.body.rows[0]).toMatchObject({
        status: 'FAILED',
        applied_domains: ['CATALOGO'],
        steps: [
          { dominio: 'CATALOGO', status: 'COMPLETED' },
          { dominio: 'PRICING', status: 'FAILED' },
        ],
      });
      const report = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/importaciones/${batch.batchId}/reporte`,
      );
      expect(report.status).toBe(200);
      expect(report.text).toContain('PRICE_REJECTED');
      const resumed = await request(app.getHttpServer()).post(
        `/api/v1/carga-masiva/productos/importaciones/${batch.batchId}/reanudar`,
      );
      expect(resumed.status).toBe(202);
      expect(resumed.body).toMatchObject({
        batch_id: batch.batchId,
        status: 'QUEUED',
        template_version: 2,
        correlation_id: batch.correlationId,
      });

      const exportCreated = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/exportaciones')
        .send({ formato: 'CSV' });
      expect(exportCreated.status).toBe(202);
      expect(exportCreated.body).toMatchObject({
        status: 'QUEUED',
        formato: 'CSV',
      });
      const exportStatus = await request(app.getHttpServer()).get(
        `/api/v1/carga-masiva/productos/exportaciones/${exportCreated.body.export_id}`,
      );
      expect(exportStatus.status).toBe(200);
      expect(exportStatus.body.status).toBe('FAILED_GENERAL');
      expect(
        (
          await request(app.getHttpServer()).get(
            `/api/v1/carga-masiva/productos/exportaciones/${exportCreated.body.export_id}/archivo`,
          )
        ).status,
      ).toBe(503);
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/carga-masiva/productos/exportaciones/not-a-uuid',
          )
        ).body,
      ).toMatchObject({ code: 'LOTE_NO_ENCONTRADO', status: 404 });
      expect(
        (
          await request(app.getHttpServer())
            .post('/api/v1/carga-masiva/productos/exportaciones')
            .send({ formato: 'PDF' })
        ).body,
      ).toMatchObject({ code: 'VALIDACION', status: 400 });
      const overLimit = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .attach('archivo', Buffer.alloc(10_485_761), 'over-limit.csv');
      expect(overLimit.status).toBe(413);
      expect(overLimit.body).toMatchObject({
        code: 'ARCHIVO_EXCEDE_LIMITE',
        status: 413,
      });

      const invalid = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .field('template_version', '2')
        .attach('archivo', createBulkTemplateCsv(), 'items.json');
      expect(invalid.status).toBe(422);
      expect(invalid.headers['content-type']).toContain(
        'application/problem+json',
      );
    } finally {
      await app.close();
    }
  });
});

describe('Bulk export HTTP authentication (isolated signed-key boundary)', () => {
  afterEach(() => {
    delete process.env.GATEWAY_DEMO_NO_AUTH_ENABLED;
    delete process.env.BULK_DEMO_GATEWAY_IPS;
    delete process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.G7_JWT_ISSUER;
  });

  it('rejects missing identity and insufficient role, then admits a signed authorized user', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'false';
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    process.env.G7_JWT_ISSUER = 'bulk-http-test-issuer';
    const token = (roles: string[]) => {
      const encode = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const header = encode({ alg: 'RS256', typ: 'JWT' });
      const claims = encode({
        iss: 'bulk-http-test-issuer',
        sub: 'isolated-http-test-subject',
        aud: 'api-productos',
        exp: Math.floor(Date.now() / 1000) + 600,
        roles,
      });
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      return `${header}.${claims}.${signer.sign(privateKey, 'base64url')}`;
    };
    const module = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [
        BulkSvcService,
        { provide: BulkImportService, useValue: {} },
        { provide: BulkStorageService, useValue: {} },
        {
          provide: BulkExportService,
          useValue: { create: vi.fn().mockResolvedValue({ status: 'QUEUED' }) },
        },
        {
          provide: BulkReadinessService,
          useValue: { check: vi.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
    try {
      const route = '/api/v1/carga-masiva/productos/exportaciones';
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .send({ formato: 'CSV' })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set('authorization', `Bearer ${token([])}`)
            .send({ formato: 'CSV' })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .post(route)
            .set('authorization', `Bearer ${token(['GESTOR_COMERCIAL'])}`)
            .send({ formato: 'CSV' })
        ).status,
      ).toBe(202);
    } finally {
      await app.close();
    }
  });
});
