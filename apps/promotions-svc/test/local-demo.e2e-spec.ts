import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PromotionsSvcModule } from '../src/promotions-svc.module.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../src/infrastructure/config/promotions-config.js';
import { createEnvironmentFixture } from './support/environment.js';

describe('Local demo HTTP with unchanged business boundaries', () => {
  const fixture = createEnvironmentFixture();
  let app: INestApplication;
  afterAll(() => fixture.cleanup());
  afterEach(async () => app?.close());

  async function start(enabled: boolean) {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        GATEWAY_DEMO_NO_AUTH_ENABLED: String(enabled),
      }),
    );
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useValue(config)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    return app.getHttpServer();
  }

  it('keeps JWT required by default', async () => {
    const server = await start(false);
    await request(server).get('/api/v1/cupones').expect(401);
    await request(server).post('/api/v1/cupones').send({}).expect(401);
  });

  it('runs request validation without JWT and preserves unknown-route rejection', async () => {
    const server = await start(true);
    const result = await request(server)
      .post('/api/v1/cupones')
      .set('Authorization', 'Bearer not-a-trusted-identity')
      .send({})
      .expect(400);
    expect(result.body.code).toBe('VALIDACION');
    expect(result.headers['x-correlation-id']).toBeTruthy();
    await request(server).get('/api/v1/cupones?pagina=0').expect(400);
    await request(server).delete('/api/v1/cupones').expect(404);
  });

  it('keeps a missing commercial source explicit instead of returning invented prices', async () => {
    const server = await start(true);
    const result = await request(server)
      .post('/api/v1/promociones/evaluar')
      .send({
        channel_id: 'MARKETPLACE',
        lines: [{ sku: 'SKU-TEST', quantity: 1 }],
      })
      .expect(503);
    expect(result.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    expect(result.body).not.toHaveProperty('result_amount');
  });
});
