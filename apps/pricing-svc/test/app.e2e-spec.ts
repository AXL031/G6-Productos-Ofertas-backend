import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { PricingSvcModule } from './../src/pricing-svc.module.js';
import { PricingReadiness } from '../src/health/pricing-readiness.js';
import { SignedUser } from './signed-user.js';

describe('PricingSvcController (e2e)', () => {
  let app: INestApplication<App>;
  const check = vi.fn<() => Promise<boolean>>();
  const env = {
    NODE_ENV: 'test',
    PRICING_SVC_PORT: '3002',
    DATABASE_URL: 'postgresql://pricing:fixture@127.0.0.1:1/fixture',
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PricingSvcModule.forRoot(env)],
    })
      .overrideProvider(PricingReadiness)
      .useValue({ check })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'pricing-svc',
    });
  });

  it('liveness sigue en 200 mientras readiness es 503; vuelve a 200 al recuperarse', async () => {
    check.mockResolvedValue(false);
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok', service: 'pricing-svc' });
    expect(check).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503)
      .expect({ status: 'not_ready', service: 'pricing-svc' });
    check.mockResolvedValue(true);
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ready', service: 'pricing-svc' });
  });

  it('el proveedor real responde 503 ante PostgreSQL inaccesible, sin exponer la URL', async () => {
    const module = await Test.createTestingModule({
      imports: [PricingSvcModule.forRoot(env)],
    }).compile();
    const realApp = module.createNestApplication();
    try {
      await realApp.init();
      await request(realApp.getHttpServer()).get('/health').expect(200);
      const response = await request(realApp.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(response.body).toEqual({
        status: 'not_ready',
        service: 'pricing-svc',
      });
      expect(response.text).not.toContain(env.DATABASE_URL);
    } finally {
      await realApp.close();
    }
  });

  it('consulta autenticada devuelve Problem 503 con DB caída, sin SQL ni credenciales', async () => {
    const identity = new SignedUser();
    await identity.start();
    const module = await Test.createTestingModule({
      imports: [
        PricingSvcModule.forRoot({
          ...env,
          AUTH_ISSUER: identity.issuer,
          AUTH_JWKS_URL: identity.issuer + '/jwks',
        }),
      ],
    }).compile();
    const failedDbApp = module.createNestApplication();
    try {
      await failedDbApp.init();
      const response = await request(failedDbApp.getHttpServer())
        .get('/api/v1/precios/productos/fixture')
        .set('Authorization', `Bearer ${identity.token()}`)
        .expect(503);
      expect(response.body).toMatchObject({
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
      });
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.text).not.toMatch(
        /postgresql|fixture|ECONNREFUSED|select/i,
      );
    } finally {
      await failedDbApp.close();
      await identity.stop();
    }
  });

  afterEach(async () => {
    check.mockReset();
    await app.close();
  });
});
