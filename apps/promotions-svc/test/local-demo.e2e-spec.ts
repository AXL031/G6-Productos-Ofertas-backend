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

  async function start() {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
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
    const server = await start();
    await request(server).get('/api/v1/cupones').expect(401);
    await request(server).post('/api/v1/cupones').send({}).expect(401);
  });

  it('rejects the legacy token-free flag during startup', () => {
    expect(() =>
      validatePromotionsConfiguration({
        ...fixture.environment,
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      }),
    ).toThrow('GATEWAY_DEMO_NO_AUTH_ENABLED');
  });
});
