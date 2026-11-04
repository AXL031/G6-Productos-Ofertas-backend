import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { PriceAuditSvcModule } from '../src/price-audit-svc.module.js';
import { AuditRepository } from '../src/persistence/audit.repository.js';
import { AUDIT_EXPORT_WORKER } from '../src/http/audit.controller.js';
import { type AuditChange } from '../src/domain/audit.js';
import { IsolatedAuditPostgres } from './isolated-postgres.js';
import { SignedUser } from './signed-user.js';

describe.skipIf(process.env.PRICE_AUDIT_TEST_POSTGRES !== '1')(
  'Price Audit HTTP/PostgreSQL aislado',
  () => {
    const database = new IsolatedAuditPostgres();
    const identity = new SignedUser();
    const worker = { supports: () => true, wake: vi.fn(), download: vi.fn() };
    let app: INestApplication;
    let repository: AuditRepository;
    let runtime: Pool;
    const base = '/api/v1/auditoria-precios';
    const entry = (
      sku: string,
      values: Partial<AuditChange> = {},
    ): AuditChange => ({
      sku,
      productId: 'authoritative-product',
      priceType: 'REGULAR',
      previous: null,
      next: '12.30',
      variation: null,
      operation: 'CREACION',
      channel: 'GLOBAL',
      reason: 'ALTA_PRODUCTO',
      batchId: null,
      userId: null,
      email: null,
      ip: null,
      at: new Date('2026-10-01T00:00:00Z'),
      ...values,
    });
    const message = () => ({
      id: randomUUID(),
      correlationId: randomUUID(),
      payload: { fixture: 'No es el payload P-AUD-02 aprobado' },
    });
    const get = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer ' + identity.token());
    beforeAll(async () => {
      await database.start();
      await identity.start();
      runtime = new Pool({ connectionString: database.runtimeUrl, ssl: false });
      const module = await Test.createTestingModule({
        imports: [
          PriceAuditSvcModule.forRoot({
            NODE_ENV: 'test',
            PRICE_AUDIT_SVC_PORT: '3003',
            DATABASE_URL: database.runtimeUrl,
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: identity.issuer + '/jwks',
          }),
        ],
      })
        .overrideProvider(AUDIT_EXPORT_WORKER)
        .useValue(worker)
        .compile();
      app = module.createNestApplication({ logger: false });
      await app.init();
      repository = app.get(AuditRepository);
    }, 90000);
    afterAll(async () => {
      await app?.close();
      await runtime?.end();
      await identity.stop();
      await database.stop();
    });

    it('consume e inserta todos los asientos en un solo commit; deduplica entregas concurrentes', async () => {
      const incoming = message();
      const changes = [
        entry('dedupe'),
        entry('dedupe', {
          priceType: 'OFERTA',
          previous: '5',
          next: null,
          operation: 'RETIRO_OFERTA',
        }),
      ];
      const results = await Promise.all([
        repository.append(incoming, changes),
        repository.append(incoming, changes),
      ]);
      expect(results.filter((r) => r.duplicate)).toHaveLength(1);
      const response = await get(base + '?sku=dedupe').expect(200);
      expect(response.body.meta.total).toBe(2);
      expect(
        response.body.items.find(
          (r: { tipo_operacion: string }) => r.tipo_operacion === 'CREACION',
        ),
      ).toMatchObject({
        precio_anterior: null,
        precio_nuevo: 12.3,
        variacion_porcentual: null,
      });
      expect(
        response.body.items.find(
          (r: { tipo_operacion: string }) =>
            r.tipo_operacion === 'RETIRO_OFERTA',
        ),
      ).toMatchObject({ precio_nuevo: null, variacion_porcentual: null });
      expect(response.body.items[0]).not.toHaveProperty('currency');
      expect(response.body.items[0]).not.toHaveProperty('inboxId');
    });
    it('listado y detalle conservan los decimales del servidor en el JSON recibido', async () => {
      for (const value of [
        '0.10000000000000000001',
        '9007199254740993.01',
        '9999999999999999999999999999.99',
        '1.2300',
      ]) {
        const sku = 'precision-' + randomUUID();
        await repository.append(message(), [
          entry(sku, {
            operation: 'MODIFICACION',
            previous: value,
            next: value,
            variation: '-16.67',
          }),
        ]);
        const listing = await get(base + '?sku=' + sku).expect(200);
        const detail = await get(
          base + '/' + listing.body.items[0].id_auditoria,
        ).expect(200);
        for (const response of [listing, detail]) {
          expect(response.text).toContain('"precio_anterior":' + value + ',');
          expect(response.text).toContain('"precio_nuevo":' + value + ',');
          expect(response.text).toContain('"variacion_porcentual":-16.67,');
        }
      }
    });
    it('revierte Inbox si el INSERT de asientos falla y permite reprocesar', async () => {
      const incoming = message();
      await database.admin!.query(
        'REVOKE INSERT ON price_audit.price_audit_log FROM price_audit_app',
      );
      try {
        await expect(
          repository.append(incoming, [entry('rollback')]),
        ).rejects.toThrow('Persistencia');
      } finally {
        await database.admin!.query(
          'GRANT INSERT ON price_audit.price_audit_log TO price_audit_app',
        );
      }
      expect(
        (
          await database.admin!.query(
            'SELECT count(*)::int AS total FROM price_audit.inbox WHERE message_id=$1',
            [incoming.id],
          )
        ).rows[0].total,
      ).toBe(0);
      await expect(
        repository.append(incoming, [entry('rollback')]),
      ).resolves.toEqual({ duplicate: false });
    });
    it('mantiene permisos mínimos, append-only e independencia del schema ajeno', async () => {
      for (const sql of [
        'UPDATE price_audit.price_audit_log SET motivo_cambio=motivo_cambio',
        'DELETE FROM price_audit.price_audit_log',
        'TRUNCATE price_audit.price_audit_log',
        'UPDATE price_audit.inbox SET result=result',
        'SELECT * FROM foreign_fixture.secret',
        'SET ROLE po_price_audit_owner',
      ])
        await expect(runtime.query(sql)).rejects.toMatchObject({
          code: '42501',
        });
      await expect(
        database.admin!.query(
          'UPDATE price_audit.price_audit_log SET motivo_cambio=motivo_cambio',
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
    it('devuelve orden estable, filtros combinados y paginación sin confundir vacío con error', async () => {
      const batch = randomUUID();
      await repository.append(message(), [
        entry('filters', { userId: 'user', batchId: batch }),
        entry('filters', {
          at: new Date('2026-10-02T00:00:00Z'),
          userId: 'user',
          batchId: batch,
        }),
      ]);
      const url = `${base}?sku=filters&usuarioId=user&batchId=${batch}&canal=GLOBAL&desde=2026-10-01T00:00:00Z&hasta=2026-10-02T00:00:00Z&tamanio=1`;
      const first = await get(url).expect(200);
      const second = await get(url + '&pagina=2').expect(200);
      expect(first.body.meta).toEqual({
        pagina: 1,
        tamanio: 1,
        total: 2,
        totalPaginas: 2,
      });
      expect(first.body.items[0].timestamp).toBe('2026-10-02T00:00:00.000Z');
      expect(second.body.items[0].id_auditoria).not.toBe(
        first.body.items[0].id_auditoria,
      );
      await get(base + '/' + first.body.items[0].id_auditoria).expect(200);
      expect(
        (await get(base + '?sku=absent').expect(200)).body.meta.total,
      ).toBe(0);
      expect((await get(base + '/' + randomUUID()).expect(404)).body.code).toBe(
        'AUDITORIA_PRECIO_NO_ENCONTRADA',
      );
    });
    it('deniega 401/403 antes de exponer PII y rechaza fechas/correlación inválidas', async () => {
      await request(app.getHttpServer()).get(base).expect(401);
      const forbidden = await request(app.getHttpServer())
        .get(base)
        .set(
          'Authorization',
          'Bearer ' + identity.token({ roles: ['COMPRADOR'] }),
        )
        .expect(403);
      expect(forbidden.body).not.toHaveProperty('items');
      await get(base + '?desde=2026-02-30T00:00:00Z').expect(400);
      await get(base).set('X-Correlation-Id', 'invalid').expect(400);
      await request(app.getHttpServer())
        .get(base)
        .set('Authorization', 'Bearer ' + identity.token({ exp: 1 }))
        .expect(401);
      await request(app.getHttpServer())
        .get(base)
        .set(
          'Authorization',
          'Bearer ' + identity.token({ iss: 'https://other.invalid' }),
        )
        .expect(401);
    });
    it('no admite formatos JSON ambiguos como una solicitud de exportación', async () => {
      for (const formato of [['CSV'], {}, null, 'XLSX']) {
        await request(app.getHttpServer())
          .post(base + '/exportaciones')
          .set('Authorization', 'Bearer ' + identity.token())
          .send({ formato })
          .expect(400);
      }
    });
    it('rechaza PDF de 501 filas sin crear job; acepta CSV con conteo autoritativo', async () => {
      await repository.append(
        message(),
        Array.from({ length: 501 }, () => entry('export-limit')),
      );
      const before = (
        await database.admin!.query(
          'SELECT count(*)::int AS total FROM price_audit.export_jobs',
        )
      ).rows[0].total;
      const denied = await request(app.getHttpServer())
        .post(base + '/exportaciones')
        .set('Authorization', 'Bearer ' + identity.token())
        .send({ formato: 'PDF', sku: 'export-limit' })
        .expect(422);
      expect(denied.body.code).toBe('LIMITE_EXPORTACION_AUDITORIA_EXCEDIDO');
      expect(
        (
          await database.admin!.query(
            'SELECT count(*)::int AS total FROM price_audit.export_jobs',
          )
        ).rows[0].total,
      ).toBe(before);
      const created = await request(app.getHttpServer())
        .post(base + '/exportaciones')
        .set('Authorization', 'Bearer ' + identity.token())
        .send({ formato: 'CSV', sku: 'export-limit' })
        .expect(202);
      expect(created.body).toMatchObject({
        status: 'QUEUED',
        formato: 'CSV',
        download_url: null,
      });
      expect(worker.wake).toHaveBeenCalledOnce();
      const stored = await get(
        base + '/exportaciones/' + created.body.export_id,
      ).expect(200);
      expect(stored.body.status).toBe('QUEUED');
      await get(
        base + '/exportaciones/' + created.body.export_id + '/archivo',
      ).expect(503);
      await get(base + '/exportaciones/' + randomUUID()).expect(404);
      expect(
        (
          await database.admin!.query(
            'SELECT record_count FROM price_audit.export_jobs WHERE id=$1',
            [created.body.export_id],
          )
        ).rows[0].record_count,
      ).toBe(501);
    });
    it('mantiene la bitacora sin escrituras HTTP de edicion o borrado', async () => {
      for (const method of ['put', 'patch', 'delete'] as const) {
        await request(app.getHttpServer())
          [method](base + '/' + randomUUID())
          .set('Authorization', 'Bearer ' + identity.token())
          .send({})
          .expect(404);
      }
      await request(app.getHttpServer())
        .post(base)
        .set('Authorization', 'Bearer ' + identity.token())
        .send({})
        .expect(404);
    });
    it('readiness no acredita un schema que carece de la migracion tipada', async () => {
      await database.admin!.query(
        'ALTER TABLE price_audit.price_audit_log RENAME COLUMN target_type TO pending_target_type',
      );
      try {
        await request(app.getHttpServer()).get('/health/ready').expect(503);
      } finally {
        await database.admin!.query(
          'ALTER TABLE price_audit.price_audit_log RENAME COLUMN pending_target_type TO target_type',
        );
      }
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    });
    it('readiness detecta pérdida de permiso DB mientras liveness permanece disponible', async () => {
      await request(app.getHttpServer()).get('/health/ready').expect(200);
      await database.admin!.query(
        'REVOKE SELECT ON price_audit.inbox FROM price_audit_app',
      );
      try {
        await request(app.getHttpServer()).get('/health/ready').expect(503);
        await request(app.getHttpServer()).get('/health/live').expect(200);
        const failed = await get(base).expect(200); // La lectura de bitácora no depende de Inbox.
        expect(failed.body.items.length).toBeGreaterThan(0);
      } finally {
        await database.admin!.query(
          'GRANT SELECT ON price_audit.inbox TO price_audit_app',
        );
      }
    });
    it.each([
      { targetType: 'PRODUCTO' as const, sku: null, channel: 'MARKETPLACE' },
      { targetType: 'SKU' as const, sku: 'global-read', channel: null },
      { targetType: 'PRODUCTO' as const, sku: null, channel: null },
    ])('aisla la lectura HTTP pendiente del contrato: %j', async (values) => {
      const batchId = randomUUID();
      await repository.append(message(), [
        entry('ordinary', { batchId }),
        entry('nullable', { ...values, batchId }),
      ]);
      const { items, total } = await repository.list({ batchId }, 1, 20);
      expect(total).toBe(2);
      const nullable = items.find(
        (item) => item.sku === values.sku && item.channel === values.channel,
      )!;
      expect(nullable).toBeDefined();
      const detail = await get(base + '/' + nullable.id).expect(503);
      const listing = await get(base + '?batchId=' + batchId).expect(503);
      for (const response of [listing, detail]) {
        expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
        expect(response.body).not.toHaveProperty('items');
      }
      const ordinary = items.find((item) => item.sku === 'ordinary')!;
      await get(base + '/' + ordinary.id).expect(200);
    });
  },
);
