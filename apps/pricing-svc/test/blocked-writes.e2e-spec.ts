import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PricingSvcModule } from '../src/pricing-svc.module.js';
import { PricingMutations } from '../src/application/pricing-mutations.js';
import { PricingRepository } from '../src/persistence/pricing.repository.js';

// Provider HTTP exclusivamente: no acredita persistencia ni E2E con Gateway.
describe('Fronteras de escritura bloqueadas por contrato', () => {
  let app: INestApplication<App>;
  const update = vi.fn();
  const schedule = vi.fn();
  const transaction = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PricingSvcModule.forRoot({
          NODE_ENV: 'test',
          PRICING_SVC_PORT: '3002',
          DATABASE_URL: 'postgresql://pricing:fixture@127.0.0.1:1/fixture',
          GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        }),
      ],
    })
      .overrideProvider(PricingMutations)
      .useValue({ update, schedule })
      .overrideProvider(PricingRepository)
      .useValue({ transaction })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['PATCH', '/api/v1/precios/productos/producto'],
    ['PATCH', '/api/v1/precios/skus/SKU'],
    ['POST', '/api/v1/precios/productos/producto/programaciones'],
    ['POST', '/api/v1/precios/skus/SKU/programaciones'],
    ['POST', '/api/v1/precios/importaciones/prevalidar'],
    ['POST', '/api/v1/precios/importaciones'],
  ])(
    '%s %s no admite cambios ni hechos Outbox con contrato pendiente',
    async (method, path) => {
      const client = request(app.getHttpServer());
      const call = method === 'PATCH' ? client.patch(path) : client.post(path);
      await call
        .send({ precioRegular: 12.3, priceVersion: 1 })
        .expect(path.includes('/importaciones') ? 404 : 503);
      expect(update).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
