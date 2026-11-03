import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { TaxonomySvcModule } from './../src/taxonomy-svc.module.js';
import { TaxonomyAuthGuard } from '../src/taxonomy-auth.js';

const URL_CAIDA = 'postgresql://postgres:postgres@127.0.0.1:1/taxonomy';

async function crearApp(databaseUrl: string): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [TaxonomySvcModule.forRoot({ databaseUrl })],
  })
    .overrideGuard(TaxonomyAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

describe('TaxonomySvc (e2e) — cableado del repositorio Drizzle (#35)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    app = await crearApp(URL_CAIDA);
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health responde 200 sin consultar la base', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'taxonomy-svc' }));

  it('/api/v1/categorias responde 503 desde el repositorio Drizzle, no desde el no configurado', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/categorias')
      .expect(503);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    expect(String(res.body.detail)).toContain('Base de datos de taxonomia');
    expect(String(res.body.detail)).not.toContain('no configurada');
  });

  it('/health/readiness responde 503 cuando la base está caída', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(503);

    expect(res.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });
});
