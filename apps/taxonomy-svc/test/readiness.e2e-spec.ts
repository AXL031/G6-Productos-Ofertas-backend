import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TaxonomySvcModule } from '../src/taxonomy-svc.module.js';
import { TAXONOMY_REPOSITORY } from '../src/taxonomy.repository.js';
import { TaxonomyAmqpRuntime } from '../src/domain/taxonomy-amqp.runtime.js';

describe('Taxonomy readiness versus liveness', () => {
  it('checks repository readiness for each request and recovers', async () => {
    let ready = true;
    const module = await Test.createTestingModule({
      imports: [TaxonomySvcModule],
    })
      .overrideProvider(TAXONOMY_REPOSITORY)
      .useValue({ readiness: async () => ready })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).get('/health/ready').expect(200);
      ready = false;
      await request(app.getHttpServer()).get('/health/ready').expect(503);
      await request(app.getHttpServer()).get('/health').expect(200);
      ready = true;
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    } finally {
      await app.close();
    }
  });

  it('maps an unexpected verificarReadiness rejection to 503 SERVICIO_NO_DISPONIBLE', async () => {
    const module = await Test.createTestingModule({
      imports: [TaxonomySvcModule],
    })
      .overrideProvider(TAXONOMY_REPOSITORY)
      .useValue({
        verificarReadiness: async () => {
          throw new Error('unexpected readiness failure with private details');
        },
      })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/health/readiness')
        .expect(503);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body).toMatchObject({
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
      });
      expect(JSON.stringify(response.body)).not.toContain(
        'unexpected readiness failure',
      );
      await request(app.getHttpServer()).get('/health').expect(200);
    } finally {
      await app.close();
    }
  });

  it('returns 503 when configured AMQP is paused while liveness stays 200', async () => {
    const module = await Test.createTestingModule({
      imports: [TaxonomySvcModule],
    })
      .overrideProvider(TAXONOMY_REPOSITORY)
      .useValue({ readiness: async () => true })
      .overrideProvider(TaxonomyAmqpRuntime)
      .useValue({ disponible: () => false })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const readiness = await request(app.getHttpServer())
        .get('/health/readiness')
        .expect(503);
      expect(readiness.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      await request(app.getHttpServer()).get('/health').expect(200);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['un objeto sin métodos de readiness', {}],
    ['un valor nulo', null],
  ])(
    'falla de forma explícita (503) ante %s en el indicador',
    async (_caso, indicador) => {
      const module = await Test.createTestingModule({
        imports: [TaxonomySvcModule],
      })
        .overrideProvider(TAXONOMY_REPOSITORY)
        .useValue(indicador)
        .compile();
      const app = module.createNestApplication();
      await app.init();
      try {
        await request(app.getHttpServer()).get('/health/readiness').expect(503);
        await request(app.getHttpServer()).get('/health/ready').expect(503);
      } finally {
        await app.close();
      }
    },
  );
});
