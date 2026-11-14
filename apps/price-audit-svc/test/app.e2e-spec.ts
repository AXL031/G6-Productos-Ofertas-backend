import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SignedUser } from './signed-user.js';
import { AuditRepository } from '../src/persistence/audit.repository.js';
import { PriceAuditSvcModule } from './../src/price-audit-svc.module.js';
import {
  AUDIT_EXPORT_WORKER,
  type AuditExportWorker,
} from '../src/http/audit.controller.js';

describe('PriceAuditSvcController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PriceAuditSvcModule.forRoot({
          NODE_ENV: 'test',
          PRICE_AUDIT_SVC_PORT: '3003',
          DATABASE_URL: 'postgresql://audit:unconnected@127.0.0.1/audit_test',
          AUTH_ISSUER: 'https://identity.invalid',
          AUTH_JWKS_URL: 'https://identity.invalid/jwks',
        }),
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'price-audit-svc',
    });
  });
  it('inhabilita CSV/PDF sin almacenamiento configurado', () => {
    const worker = app.get<AuditExportWorker>(AUDIT_EXPORT_WORKER);
    expect(worker.supports('CSV')).toBe(false);
    expect(worker.supports('PDF')).toBe(false);
  });

  it('lista y consulta registros globales de producto para el gestor', async () => {
    const identity = new SignedUser();
    await identity.start();
    const id = '11111111-1111-4111-8111-111111111111';
    const row = {
      id,
      targetType: 'PRODUCTO',
      sku: null,
      channel: null,
      productId: id,
      priceType: 'REGULAR',
      previous: null,
      next: '90.15',
      variation: null,
      operation: 'CREACION',
      reason: 'Alta',
      batchId: null,
      userId: null,
      email: null,
      ip: null,
      at: new Date('2026-11-07T00:00:00Z'),
    };
    const repository = {
      list: vi.fn().mockResolvedValue({ items: [row], total: 1 }),
      detail: vi.fn().mockResolvedValue(row),
    };
    const module = await Test.createTestingModule({
      imports: [
        PriceAuditSvcModule.forRoot({
          NODE_ENV: 'test',
          PRICE_AUDIT_SVC_PORT: '3003',
          DATABASE_URL: 'postgresql://audit:unconnected@127.0.0.1/audit_test',
          AUTH_ISSUER: identity.issuer,
          AUTH_JWKS_URL: identity.issuer + '/jwks',
        }),
      ],
    })
      .overrideProvider(AuditRepository)
      .useValue(repository)
      .compile();
    const candidate = module.createNestApplication();
    try {
      await candidate.init();
      const http = request(candidate.getHttpServer());
      const path = '/api/v1/auditoria-precios/administracion';
      const manager = 'Bearer ' + identity.token();
      await http.get(path).expect(401);
      await http
        .get(path)
        .set('Authorization', 'Bearer ' + identity.token({ roles: [] }))
        .expect(403);
      expect(repository.list).not.toHaveBeenCalled();
      const list = await http
        .get(path)
        .set('Authorization', manager)
        .expect(200);
      expect(list.body).toMatchObject({
        items: [{ id_auditoria: id, sku: null, canal_origen: null }],
        meta: { total: 1 },
      });
      const detail = await http
        .get(path + '/' + id)
        .set('Authorization', manager)
        .expect(200);
      expect(detail.body).toMatchObject({
        target_type: 'PRODUCTO',
        sku: null,
        canal_origen: null,
        precio_nuevo: 90.15,
      });
      await http
        .get('/api/v1/auditoria-precios/' + id)
        .set('Authorization', manager)
        .expect(503);
    } finally {
      await candidate.close();
      await identity.stop();
    }
  });

  afterEach(async () => {
    await app.close();
  });
});
