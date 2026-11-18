import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PromotionsSvcModule } from '../src/promotions-svc.module.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../src/infrastructure/config/promotions-config.js';
import { createEnvironmentFixture } from './support/environment.js';

describe('H5 candidate HTTP boundary remains isolated', () => {
  let app: INestApplication;
  const fixture = createEnvironmentFixture();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useValue(
        new PromotionsConfigService(
          validatePromotionsConfiguration(fixture.environment),
        ),
      )
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    fixture.cleanup();
  });
  it('does not expose admission or operation reads before contract/G7 review', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumos')
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/cupones/restauraciones')
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .get(
        '/api/v1/cupones/operaciones/11111111-1111-4111-8111-111111111111?order_id=PED-1',
      )
      .expect(404);
  });
});
