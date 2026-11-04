import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

  afterEach(async () => {
    await app.close();
  });
});
