import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { PricingSvcModule } from './../src/pricing-svc.module.js';
import { PricingReadiness } from '../src/health/pricing-readiness.js';
import { SignedUser } from './signed-user.js';
import {
  PricingRepository,
  type PriceLookupTarget,
} from '../src/persistence/pricing.repository.js';

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

  it('reads only the requested editable definition using a signed manager JWT', async () => {
    const identity = new SignedUser();
    await identity.start();
    const readDefinition = vi.fn(
      async (target: PriceLookupTarget, channel: string | null) =>
        channel === 'MARKETPLACE'
          ? undefined
          : {
              definition: {
                productId: target.productId ?? null,
                sku: target.sku ?? null,
                channelId: channel,
                priceVersion: channel === null ? 3n : 7n,
              },
              validities: [
                {
                  precioRegular: '79.50',
                  precioOferta: null,
                  currency: 'PEN',
                  validFrom: new Date('2020-01-01T00:00:00Z'),
                  validUntil: null,
                },
              ],
            },
    );
    const module = await Test.createTestingModule({
      imports: [
        PricingSvcModule.forRoot({
          ...env,
          AUTH_ISSUER: identity.issuer,
          AUTH_JWKS_URL: identity.issuer + '/jwks',
        }),
      ],
    })
      .overrideProvider(PricingRepository)
      .useValue({ readDefinition })
      .compile();
    const adminApp = module.createNestApplication();
    try {
      await adminApp.init();
      const http = request(adminApp.getHttpServer());
      const bearer = 'Bearer ' + identity.token();
      const id = '11111111-1111-4111-8111-111111111111';
      const product = '/api/v1/precios/administracion/productos/' + id;
      const sku = '/api/v1/precios/administracion/skus/SKU-1';
      await http.get(product).expect(401);
      await http
        .get(product)
        .set('Authorization', 'Bearer ' + identity.token({ roles: [] }))
        .expect(403);
      await http
        .get(sku)
        .set(
          'Authorization',
          'Bearer ' +
            identity.token({
              tipo: 'servicio',
              sub: 'modulo-marketplace',
              aud: 'api-productos',
              scope: 'precios:leer',
            }),
        )
        .expect(401);
      await http
        .get(product + '?channelId=retail')
        .set('Authorization', bearer)
        .expect(400);
      expect(readDefinition).not.toHaveBeenCalled();
      const global = await http
        .get(product)
        .set('Authorization', bearer)
        .expect(200);
      expect(global.body).toMatchObject({
        productId: id,
        sku: null,
        channelId: null,
        priceVersion: 3,
        vigenciaActual: {
          precioRegular: 79.5,
          precioOferta: null,
          currency: 'PEN',
        },
      });
      const retail = await http
        .get(sku + '?channelId=RETAIL')
        .set('Authorization', bearer)
        .expect(200);
      expect(retail.body).toMatchObject({
        productId: null,
        sku: 'SKU-1',
        channelId: 'RETAIL',
        priceVersion: 7,
      });
      expect(readDefinition).toHaveBeenLastCalledWith(
        { sku: 'SKU-1' },
        'RETAIL',
      );
      const inherited = await http
        .get(product + '?channelId=MARKETPLACE')
        .set('Authorization', bearer)
        .expect(404);
      expect(inherited.body.code).toBe('PRECIO_NO_ENCONTRADO');
      expect(readDefinition).toHaveBeenLastCalledWith(
        { productId: id },
        'MARKETPLACE',
      );
    } finally {
      await adminApp.close();
      await identity.stop();
    }
  });

  afterEach(async () => {
    check.mockReset();
    await app.close();
  });
});
