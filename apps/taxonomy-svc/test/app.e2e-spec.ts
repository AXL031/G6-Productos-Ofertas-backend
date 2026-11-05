import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { TaxonomySvcModule } from './../src/taxonomy-svc.module.js';
import { TAXONOMY_REPOSITORY } from './../src/taxonomy.repository.js';
import type { TaxonomyRepository } from './../src/taxonomy.repository.js';
import type { TaxonomyReadinessIndicator } from './../src/health/readiness.port.js';
import { RepositorioPrueba } from './repositorio-prueba.js';
import { TaxonomyAuthGuard } from '../src/taxonomy-auth.js';

const CORRELACION = '0c0d092e-6192-47c1-8d18-5ed0e2aa4518';

const REPOSITORIO_CON_FALLO: TaxonomyRepository & TaxonomyReadinessIndicator = {
  async findCategoriasActivas(): Promise<never[]> {
    throw new Error('select * from taxonomy.categories: conexion rechazada');
  },
  async findCategoriaAdmin(): Promise<never> {
    throw new Error('select from taxonomy.categories: conexion rechazada');
  },
  async findMarcasActivas(): Promise<never[]> {
    throw new Error('select * from taxonomy.brands: conexion rechazada');
  },
  async verificarReadiness(): Promise<void> {
    throw new Error('conexion con el esquema taxonomy rechazada');
  },
};

async function crearApp(
  repositorio?: TaxonomyRepository,
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [TaxonomySvcModule.forRoot()],
  });
  // Estas pruebas cubren lectura/errores; la seguridad se prueba con JWT real en taxonomy.controller.spec.ts.
  builder
    .overrideGuard(TaxonomyAuthGuard)
    .useValue({ canActivate: () => true });
  if (repositorio) {
    builder.overrideProvider(TAXONOMY_REPOSITORY).useValue(repositorio);
  }
  const moduleFixture: TestingModule = await builder.compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

describe('TaxonomySvc (e2e) — GET /api/v1/categorias y /api/v1/marcas (#22)', () => {
  let app: INestApplication<App>;
  let repositorio: RepositorioPrueba;

  beforeEach(async () => {
    repositorio = new RepositorioPrueba();
    app = await crearApp(repositorio);
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      service: 'taxonomy-svc',
    });
  });

  it('/health (GET) responde 200 sin depender de la fuente de datos', async () => {
    const appConFallo = await crearApp(REPOSITORIO_CON_FALLO);

    try {
      await request(appConFallo.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', service: 'taxonomy-svc' });
    } finally {
      await appConFallo.close();
    }
  });

  it('/health/readiness (GET) responde 200 cuando la dependencia está lista', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(200);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ status: 'ready', service: 'taxonomy-svc' });
  });

  it('/health/readiness (GET) responde 503 SERVICIO_NO_DISPONIBLE si la dependencia no está lista', async () => {
    repositorio.listo = false;

    const res = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(503);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: '/errores/servicio-no-disponible',
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
    });
  });

  it('/health/readiness (GET) responde 503 si el usuario no puede leer las tablas (42501)', async () => {
    repositorio.errorTablas = Object.assign(
      new Error('permission denied for table categories'),
      { code: '42501' },
    );

    const res = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(503);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: '/errores/servicio-no-disponible',
      status: 503,
      code: 'SERVICIO_NO_DISPONIBLE',
    });
  });

  it('/health/readiness (GET) responde 503 si falla una tabla de taxonomía', async () => {
    repositorio.errorTablas = Object.assign(
      new Error('relation "taxonomy.brands" does not exist'),
      { code: '42P01' },
    );

    const res = await request(app.getHttpServer())
      .get('/health/readiness')
      .expect(503);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });

  it('/health/readiness (GET) responde 503 en configuración sin fuente de datos, con /health aún en 200', async () => {
    const appSinFuente = await crearApp();

    try {
      await request(appSinFuente.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', service: 'taxonomy-svc' });

      const res = await request(appSinFuente.getHttpServer())
        .get('/health/readiness')
        .expect(503);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    } finally {
      await appSinFuente.close();
    }
  });

  it('/api/v1/categorias (GET) devuelve las categorías activas', async () => {
    repositorio.categorias = [
      {
        id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
        nombre: 'Accesorios deportivos',
        categoria_padre_id: null,
        estado: 'ACTIVO',
      },
    ];

    const res = await request(app.getHttpServer())
      .get('/api/v1/categorias')
      .expect(200);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      categories: [
        {
          categoria_id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
          parent_id: null,
          name: 'Accesorios deportivos',
          status: 'ACTIVA',
        },
      ],
    });
  });

  it('/api/v1/categorias (GET) devuelve la lista vacía con 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/categorias')
      .expect(200);

    expect(res.body).toEqual({ categories: [] });
  });

  it('/api/v1/marcas (GET) devuelve las marcas activas', async () => {
    repositorio.marcas = [
      {
        id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
        nombre: 'Marathon',
        descripcion: 'Marca ecuatoriana de ropa y calzado deportivo.',
        pais_origen_iso: 'EC',
        estado: 'ACTIVO',
      },
    ];

    const res = await request(app.getHttpServer())
      .get('/api/v1/marcas')
      .expect(200);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      brands: [
        {
          marca_id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
          name: 'Marathon',
          description: 'Marca ecuatoriana de ropa y calzado deportivo.',
          logo_url: null,
          country_code: 'EC',
          status: 'ACTIVA',
        },
      ],
    });
  });

  it('/api/v1/marcas (GET) devuelve la lista vacía con 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marcas')
      .expect(200);

    expect(res.body).toEqual({ brands: [] });
  });

  it('/api/v1/categorias (GET) responde 400 VALIDACION ante un query param y respalda la correlación', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/categorias?pagina=1')
      .set('x-correlation-id', CORRELACION)
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: '/errores/validacion',
      status: 400,
      code: 'VALIDACION',
      correlationId: CORRELACION,
    });
    expect(String(res.body.detail)).toContain('pagina');
  });

  it('/api/v1/marcas (GET) responde 400 VALIDACION con X-Correlation-Id inválido', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marcas')
      .set('x-correlation-id', 'no-es-uuid')
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('VALIDACION');
    expect(res.body.correlationId).toBeUndefined();
  });

  it('/api/v1/categorias (GET) responde 503 SERVICIO_NO_DISPONIBLE sin fuente de datos', async () => {
    const appSinFuente = await crearApp();

    try {
      const res = await request(appSinFuente.getHttpServer())
        .get('/api/v1/categorias')
        .expect(503);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        type: '/errores/servicio-no-disponible',
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
      });
    } finally {
      await appSinFuente.close();
    }
  });

  it('/api/v1/categorias (GET) responde 500 ERROR_INTERNO si la fuente de datos falla', async () => {
    const appConFallo = await crearApp(REPOSITORIO_CON_FALLO);

    try {
      const res = await request(appConFallo.getHttpServer())
        .get('/api/v1/categorias')
        .expect(500);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        type: '/errores/error-interno',
        status: 500,
        code: 'ERROR_INTERNO',
      });
      expect(res.body.detail).toBe(
        'Ha ocurrido un error interno en el servicio',
      );
      expect(res.body.detail).not.toContain('taxonomy.categories');
    } finally {
      await appConFallo.close();
    }
  });
});
