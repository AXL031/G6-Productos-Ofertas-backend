import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProblemDetailsException } from './errors/taxonomy.errors.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import type {
  CategoriaRow,
  MarcaRow,
  TaxonomyRepository,
} from './taxonomy.repository.js';
import { UnconfiguredTaxonomyRepository } from './unconfigured-taxonomy.repository.js';
import { RepositorioPrueba } from '../test/repositorio-prueba.js';
import {
  TaxonomyTokenVerifier,
  readTaxonomySecurityConfig,
  readTaxonomyDemoConfig,
  readTaxonomyPublicReadConfig,
  TAXONOMY_DEMO_ENABLED,
  TaxonomyAuthGuard,
} from './taxonomy-auth.js';

const CORRELACION_VALIDA = '0c0d092e-6192-47c1-8d18-5ed0e2aa4518';

describe('configuración de Seguridad de Taxonomy', () => {
  it('sin configuración no habilita autenticación alternativa', () => {
    expect(readTaxonomySecurityConfig({})).toBeUndefined();
  });

  it('rechaza configuración incompleta de issuer y JWKS', () => {
    expect(() =>
      readTaxonomySecurityConfig({ SECURITY_ISSUER: 'https://issuer.example' }),
    ).toThrow();
  });
  it('activa demo solo explícitamente en test o desarrollo', () => {
    expect(readTaxonomyDemoConfig({ NODE_ENV: 'test' })).toBe(false);
    expect(
      readTaxonomyDemoConfig({
        NODE_ENV: 'test',
        ALLOW_DEMO_UNAUTHENTICATED: 'true',
      }),
    ).toBe(true);
    expect(() =>
      readTaxonomyDemoConfig({
        NODE_ENV: 'production',
        ALLOW_DEMO_UNAUTHENTICATED: 'true',
      }),
    ).toThrow();
    expect(() =>
      readTaxonomyDemoConfig({
        NODE_ENV: 'test',
        ALLOW_DEMO_UNAUTHENTICATED: 'yes',
      }),
    ).toThrow();
  });
  it('rechaza demo desde un par TCP que no es loopback', async () => {
    const guard = new TaxonomyAuthGuard({} as TaxonomyTokenVerifier, true);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          method: 'GET',
          path: '/api/v1/categorias',
          socket: { remoteAddress: '192.0.2.1' },
        }),
      }),
    } as unknown as import('@nestjs/common').ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('no activa operaciones públicas automáticamente en PUBLIC_READ_ONLY ni concede acceso por IP privada', async () => {
    // Requisito #3: sin TAXONOMY_PUBLIC_OPERATION_IDS, hay 0 operaciones públicas
    const emptyPhase1 = readTaxonomyPublicReadConfig({
      NODE_ENV: 'production',
      G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
    });
    expect(emptyPhase1).toEqual({
      securityMode: 'PUBLIC_READ_ONLY',
      publicOperations: [],
    });

    // Requisito #4: provenir de una IP privada (ej. 172.18.0.4 o 10.0.0.5) NO concede acceso
    const guardSinOperaciones = new TaxonomyAuthGuard(
      {} as TaxonomyTokenVerifier,
      false,
      emptyPhase1,
    );
    for (const remoteAddress of [
      '172.18.0.4',
      '10.0.0.5',
      '192.168.1.10',
      '127.0.0.1',
    ]) {
      const ctx = {
        getHandler: () => ({ name: 'listarCategorias' }),
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {},
            method: 'GET',
            path: '/api/v1/categorias',
            socket: { remoteAddress },
          }),
        }),
      } as unknown as import('@nestjs/common').ExecutionContext;
      await expect(guardSinOperaciones.canActivate(ctx)).rejects.toMatchObject({
        status: 401,
      });
    }

    // Incluso con ALLOW_DEMO_UNAUTHENTICATED=true en test, una IP privada RFC1918 es rechazada
    const guardLoopbackOnly = new TaxonomyAuthGuard(
      {} as TaxonomyTokenVerifier,
      true,
    );
    const privatePeerCtx = {
      getHandler: () => ({ name: 'listarCategorias' }),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          method: 'GET',
          path: '/api/v1/categorias',
          socket: { remoteAddress: '172.18.0.4' },
        }),
      }),
    } as unknown as import('@nestjs/common').ExecutionContext;
    await expect(
      guardLoopbackOnly.canActivate(privatePeerCtx),
    ).rejects.toMatchObject({
      status: 401,
    });

    // Solo cuando la operación está explícitamente en TAXONOMY_PUBLIC_OPERATION_IDS en PUBLIC_READ_ONLY
    const explicitPhase1 = readTaxonomyPublicReadConfig({
      NODE_ENV: 'production',
      G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      TAXONOMY_PUBLIC_OPERATION_IDS: 'listarCategorias',
    });
    const guardExplicito = new TaxonomyAuthGuard(
      {} as TaxonomyTokenVerifier,
      false,
      explicitPhase1,
    );
    await expect(guardExplicito.canActivate(privatePeerCtx)).resolves.toBe(
      true,
    );
    const unapprovedOpCtx = {
      getHandler: () => ({ name: 'listarMarcas' }),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          method: 'GET',
          path: '/api/v1/marcas',
          socket: { remoteAddress: '172.18.0.4' },
        }),
      }),
    } as unknown as import('@nestjs/common').ExecutionContext;
    await expect(
      guardExplicito.canActivate(unapprovedOpCtx),
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});

const CATEGORIAS: CategoriaRow[] = [
  {
    id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
    nombre: 'Accesorios deportivos',
    categoria_padre_id: null,
    estado: 'ACTIVO',
  },
  {
    id: 'ff68d939-49a4-5dfe-91b3-bd6ebd3747c4',
    nombre: 'Chimpunes',
    categoria_padre_id: 'cd8aa953-eafd-ce4e-628b-4988ebbcded4',
    estado: 'ACTIVO',
  },
];

const MARCAS: MarcaRow[] = [
  {
    id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
    nombre: 'Marathon',
    descripcion: 'Marca ecuatoriana de ropa y calzado deportivo.',
    pais_origen_iso: 'EC',
    estado: 'ACTIVO',
  },
  {
    id: '2ae5529a-b33e-507f-900d-b4a04fc0f831',
    nombre: 'Walon',
    descripcion: null,
    pais_origen_iso: 'PE',
    estado: 'ACTIVO',
    logo_url: 'https://cdn.example.com/walon.png',
  },
  {
    id: '514d9c18-b418-559b-a692-e304183560ad',
    nombre: 'Under Armour',
    descripcion: null,
    pais_origen_iso: 'US',
    estado: 'INACTIVO',
  },
];

async function crearModulo(
  repositorio: TaxonomyRepository,
): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [TaxonomyController],
    providers: [
      TaxonomySvcService,
      { provide: TaxonomyTokenVerifier, useValue: {} },
      { provide: TAXONOMY_DEMO_ENABLED, useValue: false },
      { provide: TAXONOMY_REPOSITORY, useValue: repositorio },
    ],
  }).compile();
}

async function crearModuloSinFuente(): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [TaxonomyController],
    providers: [
      TaxonomySvcService,
      { provide: TaxonomyTokenVerifier, useValue: {} },
      { provide: TAXONOMY_DEMO_ENABLED, useValue: false },
      {
        provide: TAXONOMY_REPOSITORY,
        useClass: UnconfiguredTaxonomyRepository,
      },
    ],
  }).compile();
}

async function esperarProblema(
  promesa: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promesa;
    expect.unreachable('Debía lanzar un ProblemDetailsException');
  } catch (error) {
    const problema = error as ProblemDetailsException;
    expect(problema.problem?.status).toBe(status);
    expect(problema.problem?.code).toBe(code);
  }
}

describe('TaxonomyController — lectura de categorías y marcas (#22)', () => {
  let repositorio: RepositorioPrueba;
  let controller: TaxonomyController;

  beforeEach(async () => {
    repositorio = new RepositorioPrueba();
    const modulo = await crearModulo(repositorio);
    controller = modulo.get(TaxonomyController);
  });

  it('no expone registros inactivos ni pendientes aunque el repositorio los devuelva', async () => {
    repositorio.categorias = [
      { ...CATEGORIAS[0]!, estado: 'INACTIVO' },
      { ...CATEGORIAS[1]!, estado: 'PENDING_DEACTIVATION' },
    ];
    repositorio.marcas = [
      { ...MARCAS[0]!, estado: 'INACTIVO' },
      { ...MARCAS[1]!, estado: 'PENDING_DEACTIVATION' },
    ];

    await expect(controller.listarCategorias({})).resolves.toEqual({
      categories: [],
    });
    await expect(controller.listarMarcas({})).resolves.toEqual({ brands: [] });
  });

  describe('GET /api/v1/categorias', () => {
    it('devuelve las categorías con el DTO exacto del contrato', async () => {
      repositorio.categorias = CATEGORIAS;

      await expect(controller.listarCategorias({})).resolves.toEqual({
        categories: [
          {
            categoria_id: '49a1dbd0-666d-0d43-6d1e-1053d4564455',
            parent_id: null,
            name: 'Accesorios deportivos',
            status: 'ACTIVA',
          },
          {
            categoria_id: 'ff68d939-49a4-5dfe-91b3-bd6ebd3747c4',
            parent_id: 'cd8aa953-eafd-ce4e-628b-4988ebbcded4',
            name: 'Chimpunes',
            status: 'ACTIVA',
          },
        ],
      });
    });

    it('devuelve la lista vacía cuando no hay categorías', async () => {
      await expect(controller.listarCategorias({})).resolves.toEqual({
        categories: [],
      });
    });

    it('acepta un X-Correlation-Id con formato UUID', async () => {
      await expect(
        controller.listarCategorias({}, CORRELACION_VALIDA),
      ).resolves.toEqual({
        categories: [],
      });
    });

    it('lanza 400 VALIDACION si X-Correlation-Id no es un UUID', async () => {
      await esperarProblema(
        controller.listarCategorias({}, 'no-es-uuid'),
        400,
        'VALIDACION',
      );
    });

    it('lanza 400 VALIDACION ante un parámetro de consulta desconocido', async () => {
      await esperarProblema(
        controller.listarCategorias({ estado: 'ACTIVO' }),
        400,
        'VALIDACION',
      );
    });

    it('propaga el fallo del repositorio para que el filtro responda 500', async () => {
      repositorio.falla = true;

      await expect(controller.listarCategorias({})).rejects.toThrow(
        'rechazada',
      );
    });

    it('lanza 503 SERVICIO_NO_DISPONIBLE sin fuente de datos configurada', async () => {
      const modulo = await crearModuloSinFuente();
      const sinFuente = modulo.get(TaxonomyController);

      await esperarProblema(
        sinFuente.listarCategorias({}),
        503,
        'SERVICIO_NO_DISPONIBLE',
      );
    });
  });

  describe('GET /api/v1/marcas', () => {
    it('devuelve las marcas con el DTO exacto del contrato', async () => {
      repositorio.marcas = MARCAS;

      await expect(controller.listarMarcas({})).resolves.toEqual({
        brands: [
          {
            marca_id: '380d9fe0-0290-580a-95e6-6bcd378b9b92',
            name: 'Marathon',
            description: 'Marca ecuatoriana de ropa y calzado deportivo.',
            logo_url: null,
            country_code: 'EC',
            status: 'ACTIVA',
          },
          {
            marca_id: '2ae5529a-b33e-507f-900d-b4a04fc0f831',
            name: 'Walon',
            description: null,
            logo_url: 'https://cdn.example.com/walon.png',
            country_code: 'PE',
            status: 'ACTIVA',
          },
        ],
      });
    });

    it('devuelve la lista vacía cuando no hay marcas', async () => {
      await expect(controller.listarMarcas({})).resolves.toEqual({
        brands: [],
      });
    });

    it('lanza 400 VALIDACION ante un parámetro de consulta desconocido', async () => {
      await esperarProblema(
        controller.listarMarcas({ pagina: 1 }),
        400,
        'VALIDACION',
      );
    });

    it('lanza 400 VALIDACION si X-Correlation-Id no es un UUID', async () => {
      await esperarProblema(
        controller.listarMarcas({}, '0c0d'),
        400,
        'VALIDACION',
      );
    });

    it('propaga el fallo del repositorio para que el filtro responda 500', async () => {
      repositorio.falla = true;

      await expect(controller.listarMarcas({})).rejects.toThrow('rechazada');
    });

    it('lanza 503 SERVICIO_NO_DISPONIBLE sin fuente de datos configurada', async () => {
      const modulo = await crearModuloSinFuente();
      const sinFuente = modulo.get(TaxonomyController);

      await esperarProblema(
        sinFuente.listarMarcas({}),
        503,
        'SERVICIO_NO_DISPONIBLE',
      );
    });
  });
});
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TaxonomySvcModule } from './taxonomy-svc.module.js';
import { TAXONOMY_SECURITY_CONFIG } from './taxonomy-auth.js';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { BrandReactivationService } from './domain/brand-reactivation.service.js';
import { CategoryReactivationService } from './domain/category-reactivation.service.js';
import { CategoryCreateService } from './domain/category-create.service.js';
import { CategoryUpdateService } from './domain/category-update.service.js';
import { BrandWriteService } from './domain/brand-write.service.js';
import { TaxonomyWriteController } from './taxonomy-write.controller.js';

// Verifies actual Nest guard, JWT signature, JWKS and problem responses.
describe('listarCategorias y listarMarcas: seguridad HTTP contractual', () => {
  let server: Server;
  let app: INestApplication;
  let demoApp: INestApplication;
  let origin: string;
  const issuer = 'https://security.example.test';
  const actualizarCategoria = vi.fn().mockResolvedValue({
    estado: 'OK',
    categoria: {
      categoriaId: '11111111-1111-4111-8111-111111111111',
      nombre: 'Actualizada',
      estado: 'ACTIVO',
      version: 1,
    },
  });
  const brandWrite = {
    crear: vi.fn().mockResolvedValue({
      estado: 'OK',
      marca: {
        marcaId: '11111111-1111-4111-8111-111111111111',
        nombre: 'Marca',
        estado: 'ACTIVO',
        version: 0,
      },
    }),
    actualizar: vi.fn().mockResolvedValue({
      estado: 'OK',
      marca: {
        marcaId: '11111111-1111-4111-8111-111111111111',
        nombre: 'Marca',
        estado: 'ACTIVO',
        version: 1,
      },
    }),
  };
  const crearCategoria = vi.fn().mockResolvedValue({
    estado: 'CREADA',
    categoria: {
      categoriaId: '11111111-1111-4111-8111-111111111111',
      nombre: 'Running',
      slug: 'running',
      estado: 'ACTIVO',
      version: 0,
    },
  });
  const reactivarCategoria = vi.fn().mockResolvedValue({
    estado: 'ACTIVA',
    categoria: {
      categoriaId: '11111111-1111-4111-8111-111111111111',
      nombre: 'Prueba',
      estado: 'ACTIVO',
      version: 1,
    },
  });
  const reactivar = vi.fn().mockResolvedValue({
    estado: 'ACTIVA',
    marca: {
      marcaId: '11111111-1111-4111-8111-111111111111',
      nombre: 'Prueba',
      estado: 'ACTIVO',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  function token(
    claims: Record<string, unknown> = {},
    invalidSignature = false,
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'test' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: 'modulo-marketplace',
        tipo: 'servicio',
        aud: 'api-productos',
        scope: 'catalogo:leer',
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        ...claims,
      }),
    ).toString('base64url');
    const input = header + '.' + payload;
    const signingKey = invalidSignature
      ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      : keys.privateKey;
    return (
      input +
      '.' +
      sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')
    );
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/discovery')
        res.end(JSON.stringify({ issuer, jwks_uri: origin + '/jwks' }));
      else if (req.url === '/jwks')
        res.end(
          JSON.stringify({
            keys: [
              {
                ...keys.publicKey.export({ format: 'jwk' }),
                kid: 'test',
                alg: 'RS256',
                use: 'sig',
              },
            ],
          }),
        );
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Puerto no disponible');
    origin = 'http://127.0.0.1:' + address.port;
    const module = await Test.createTestingModule({
      imports: [TaxonomySvcModule],
    })
      .overrideProvider(TAXONOMY_SECURITY_CONFIG)
      .useValue({
        issuer,
        discoveryUrl: origin + '/discovery',
        jwksUrl: origin + '/jwks',
      })
      .overrideProvider(TAXONOMY_REPOSITORY)
      .useValue(new RepositorioPrueba())
      .overrideProvider(BrandReactivationService)
      .useValue({ reactivar })
      .overrideProvider(CategoryReactivationService)
      .useValue({ reactivar: reactivarCategoria })
      .overrideProvider(CategoryCreateService)
      .useValue({ crear: crearCategoria })
      .overrideProvider(CategoryUpdateService)
      .useValue({ actualizar: actualizarCategoria })
      .overrideProvider(BrandWriteService)
      .useValue(brandWrite)
      .compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    const demoModule = await Test.createTestingModule({
      imports: [TaxonomySvcModule],
    })
      .overrideProvider(TAXONOMY_SECURITY_CONFIG)
      .useValue({
        issuer,
        discoveryUrl: origin + '/discovery',
        jwksUrl: origin + '/jwks',
      })
      .overrideProvider(TAXONOMY_DEMO_ENABLED)
      .useValue(true)
      .overrideProvider(TAXONOMY_REPOSITORY)
      .useValue(new RepositorioPrueba())
      .overrideProvider(BrandReactivationService)
      .useValue({ reactivar })
      .overrideProvider(CategoryReactivationService)
      .useValue({ reactivar: reactivarCategoria })
      .overrideProvider(CategoryCreateService)
      .useValue({ crear: crearCategoria })
      .overrideProvider(CategoryUpdateService)
      .useValue({ actualizar: actualizarCategoria })
      .overrideProvider(BrandWriteService)
      .useValue(brandWrite)
      .compile();
    demoApp = demoModule.createNestApplication();
    await demoApp.init();
  });
  afterAll(async () => {
    await app?.close();
    await demoApp?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  it('aplica la allowlist M2M contractual directamente en Taxonomy', async () => {
    const categorias = '/api/v1/categorias';
    const marcas = '/api/v1/marcas';
    for (const cliente of [
      'modulo-marketplace',
      'modulo-chatbot',
      'modulo-retail',
    ]) {
      const autorizacion = 'Bearer ' + token({ sub: cliente });
      await request(app.getHttpServer())
        .get(categorias)
        .set('Authorization', autorizacion)
        .expect(200);
      await request(app.getHttpServer())
        .get(marcas)
        .set('Authorization', autorizacion)
        .expect(200);
    }
    for (const cliente of [
      'catalog-svc',
      'modulo-productos',
      'otro-servicio',
    ]) {
      const autorizacion = 'Bearer ' + token({ sub: cliente });
      await request(app.getHttpServer())
        .get(categorias)
        .set('Authorization', autorizacion)
        .expect(403);
      await request(app.getHttpServer())
        .get(marcas)
        .set('Authorization', autorizacion)
        .expect(403);
    }
    const scopeInsuficiente =
      'Bearer ' +
      token({ sub: 'modulo-marketplace', scope: 'catalogo:escribir' });
    await request(app.getHttpServer())
      .get(categorias)
      .set('Authorization', scopeInsuficiente)
      .expect(403);
  });
  it('actualizarCategoria valida JWT, cuerpo y conflictos', async () => {
    const path = '/api/v1/categorias/11111111-1111-4111-8111-111111111111';
    const human =
      'Bearer ' +
      token({
        tipo: 'acceso',
        sub: randomUUID(),
        roles: ['GESTOR_COMERCIAL'],
        aud: undefined,
      });
    await request(demoApp.getHttpServer())
      .patch(path)
      .send({ nombre: 'X' })
      .expect(401);
    await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', human)
      .send({ nombre: '' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', human)
      .send({ nombre: 'Actualizada' })
      .expect(200);
    actualizarCategoria.mockResolvedValueOnce({ estado: 'VERSION_CONFLICT' });
    const conflict = await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', human)
      .send({ version: 0 })
      .expect(409);
    expect(conflict.body.code).toBe('VERSION_CONFLICT');
    actualizarCategoria.mockResolvedValueOnce({ estado: 'PROFUNDIDAD' });
    const depth = await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', human)
      .send({ categoriaPadreId: '11111111-1111-4111-8111-111111111111' })
      .expect(422);
    expect(depth.body.code).toBe('PROFUNDIDAD_CATEGORIA_EXCEDIDA');
  });
  it('crear y actualizar marcas requieren usuario y aceptan multipart', async () => {
    const human =
      'Bearer ' +
      token({ tipo: 'acceso', sub: randomUUID(), roles: ['GESTOR_COMERCIAL'] });
    const png = readFileSync(
      resolve('apps/taxonomy-svc/test/fixtures/logo.png'),
    );
    await request(app.getHttpServer())
      .patch('/api/v1/marcas/11111111-1111-4111-8111-111111111111')
      .set('Authorization', human)
      .send({ nombre: 'Marca' })
      .expect(400);
    await request(demoApp.getHttpServer())
      .post('/api/v1/marcas')
      .field('nombre', 'Marca')
      .attach('logo', png, { filename: 'logo.png', contentType: 'image/png' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/marcas')
      .set('Authorization', human)
      .field('nombre', 'Marca')
      .attach('logo', png, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    expect(brandWrite.crear).toHaveBeenCalledWith(
      expect.objectContaining({ nombre: 'Marca', logoUrl: null }),
    );
    await request(app.getHttpServer())
      .post('/api/v1/marcas')
      .set('Authorization', human)
      .field('nombre', 'Marca')
      .field('logoUrl', 'https://example.org/logo.png')
      .attach('logo', png, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    expect(brandWrite.crear).toHaveBeenLastCalledWith(
      expect.objectContaining({ logoUrl: 'https://example.org/logo.png' }),
    );
    await request(app.getHttpServer())
      .patch('/api/v1/marcas/11111111-1111-4111-8111-111111111111')
      .set('Authorization', human)
      .field('nombre', 'Marca')
      .expect(200);
    await request(app.getHttpServer())
      .patch('/api/v1/marcas/11111111-1111-4111-8111-111111111111')
      .set('Authorization', human)
      .field('descripcion', '')
      .field('paisOrigenIso', '')
      .field('logo', '')
      .expect(200);
    expect(brandWrite.actualizar).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        descripcion: null,
        paisOrigenIso: null,
        logoUrl: null,
      }),
    );
    await request(app.getHttpServer())
      .patch('/api/v1/marcas/11111111-1111-4111-8111-111111111111')
      .set('Authorization', human)
      .field('paisOrigenIso', 'ZZ')
      .expect(400);
    const invalid = await request(app.getHttpServer())
      .post('/api/v1/marcas')
      .set('Authorization', human)
      .field('nombre', 'Marca')
      .attach('logo', Buffer.from('fake'), {
        filename: 'bad.png',
        contentType: 'image/png',
      })
      .expect(422);
    expect(invalid.body.code).toBe('LOGO_INVALIDO');
    const truncated = await request(app.getHttpServer())
      .post('/api/v1/marcas')
      .set('Authorization', human)
      .field('nombre', 'Marca')
      .attach('logo', png.subarray(0, 8), {
        filename: 'truncado.png',
        contentType: 'image/png',
      })
      .expect(422);
    expect(truncated.body.code).toBe('LOGO_INVALIDO');
    const tooLarge = await request(app.getHttpServer())
      .post('/api/v1/marcas')
      .set('Authorization', human)
      .field('nombre', 'Marca')
      .attach('logo', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'grande.png',
        contentType: 'image/png',
      })
      .expect(413);
    expect(tooLarge.body.code).toBe('LOGO_EXCEDE_LIMITE');
  });
  it('propaga nulos explícitos de campos opcionales al actualizar marca', async () => {
    const controller = app.get(TaxonomyWriteController);
    await controller.actualizarMarca(
      '11111111-1111-4111-8111-111111111111',
      { descripcion: null, paisOrigenIso: null, logo: null },
      'multipart/form-data; boundary=test',
      undefined,
      undefined,
    );
    expect(brandWrite.actualizar).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        descripcion: null,
        paisOrigenIso: null,
        logoUrl: null,
      }),
    );
  });
  it('crearCategoria exige JWT humano y valida el slug confirmado', async () => {
    const path = '/api/v1/categorias';
    const body = { nombre: 'Running', slugConfirmado: 'running' };
    const human =
      'Bearer ' +
      token({ tipo: 'acceso', sub: randomUUID(), roles: ['GESTOR_COMERCIAL'] });
    await request(demoApp.getHttpServer()).post(path).send(body).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', human)
      .send({ nombre: 'Running' })
      .expect(400);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', human)
      .send(body)
      .expect(201);
    crearCategoria.mockResolvedValueOnce({ estado: 'SLUG_DUPLICADO' });
    const result = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', human)
      .send(body)
      .expect(409);
    expect(result.body.code).toBe('SLUG_DUPLICADO');
  });
  it('reactivarCategoria exige usuario y comunica conflicto de padre inactivo', async () => {
    const path =
      '/api/v1/categorias/11111111-1111-4111-8111-111111111111/reactivar';
    const human =
      'Bearer ' +
      token({ tipo: 'acceso', sub: randomUUID(), roles: ['GESTOR_COMERCIAL'] });
    await request(demoApp.getHttpServer()).post(path).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer ' + token())
      .expect(403);
    const result = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', human)
      .expect(200);
    expect(result.body).toMatchObject({ estado: 'ACTIVO', version: 1 });
    reactivarCategoria.mockResolvedValueOnce({ estado: 'PADRE_INACTIVO' });
    const conflict = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', human)
      .expect(409);
    expect(conflict.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(conflict.body.code).toBe('CATEGORIA_PADRE_INACTIVA');
  });
  it('reactivarMarca exige JWT humano válido incluso con demo activada', async () => {
    const path =
      '/api/v1/marcas/11111111-1111-4111-8111-111111111111/reactivar';
    const human = token({
      tipo: 'acceso',
      sub: randomUUID(),
      roles: ['GESTOR_COMERCIAL'],
      aud: undefined,
    });
    await request(demoApp.getHttpServer()).post(path).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer ' + token())
      .expect(403);
    await request(app.getHttpServer())
      .post(path)
      .set(
        'Authorization',
        'Bearer ' +
          token({
            tipo: 'acceso',
            sub: randomUUID(),
            roles: ['GESTOR_COMERCIAL'],
            exp: 1,
          }),
      )
      .expect(401);
    const result = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer ' + human)
      .expect(200);
    expect(result.body).toMatchObject({
      marcaId: '11111111-1111-4111-8111-111111111111',
      estado: 'ACTIVO',
      version: 1,
    });
    await request(app.getHttpServer())
      .post(path)
      .set(
        'Authorization',
        'Bearer ' +
          token({ tipo: 'acceso', sub: randomUUID(), roles: undefined }),
      )
      .expect(403);
  });
  it.each([
    [
      'firma inválida',
      { tipo: 'acceso', sub: randomUUID(), roles: ['GESTOR_COMERCIAL'] },
      true,
    ],
    [
      'issuer inválido',
      {
        tipo: 'acceso',
        sub: randomUUID(),
        roles: ['GESTOR_COMERCIAL'],
        iss: 'https://wrong.example',
      },
      false,
    ],
    [
      'JWT humano expirado',
      {
        tipo: 'acceso',
        sub: randomUUID(),
        roles: ['GESTOR_COMERCIAL'],
        exp: 1,
      },
      false,
    ],
  ] as const)(
    'Taxonomy rechaza JWT humano con %s',
    async (_scenario, claims, invalidSignature) => {
      await request(app.getHttpServer())
        .post('/api/v1/marcas/11111111-1111-4111-8111-111111111111/reactivar')
        .set(
          'Authorization',
          'Bearer ' + token({ ...claims, aud: undefined }, invalidSignature),
        )
        .expect(401);
    },
  );
  it('reactivarMarca retorna Problem Details si la marca no existe o la baja sigue en curso', async () => {
    const path =
      '/api/v1/marcas/11111111-1111-4111-8111-111111111111/reactivar';
    const human =
      'Bearer ' +
      token({ tipo: 'acceso', sub: randomUUID(), roles: ['GESTOR_COMERCIAL'] });
    reactivar.mockResolvedValueOnce({ estado: 'NO_ENCONTRADA' });
    const missing = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', human)
      .expect(404);
    expect(missing.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(missing.body.code).toBe('MARCA_NO_ENCONTRADA');
    reactivar.mockResolvedValueOnce({ estado: 'BAJA_EN_PROCESO' });
    const pending = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', human)
      .expect(503);
    expect(pending.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });
  it.each(['categorias', 'marcas'])(
    'demo local restringida valida solicitudes a %s',
    async (path) => {
      const url = '/api/v1/' + path;
      await request(demoApp.getHttpServer()).get(url).expect(200);
      await request(demoApp.getHttpServer())
        .get(url)
        .set('Authorization', 'Bearer ' + token())
        .expect(200);
      await request(demoApp.getHttpServer())
        .get(url)
        .set('Authorization', 'Bearer invalid')
        .expect(401);
      await request(demoApp.getHttpServer())
        .get(url)
        .set('Authorization', 'Bearer ' + token({ scope: 'otro' }))
        .expect(403);
      await request(demoApp.getHttpServer())
        .get(url + '?pagina=1')
        .expect(400);
      await request(demoApp.getHttpServer()).post(url).expect(401);
      await request(demoApp.getHttpServer())
        .get(url + '/desconocido')
        .expect(401);
    },
  );
  it.each([
    ['categorias', 'categories'],
    ['marcas', 'brands'],
  ])('%s acepta JWT de servicio válido', async (path, field) => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/' + path)
      .set('Authorization', 'Bearer ' + token())
      .expect(200);
    expect(res.body).toEqual({ [field]: [] });
  });
  it.each(['categorias', 'marcas'])(
    '%s responde 401 sin token',
    async (path) => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/' + path)
        .expect(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        status: 401,
        code: 'TOKEN_INVALIDO',
        type: '/errores/token-invalido',
      });
    },
  );
  it.each([
    ['firma inválida', {}, true, 401, 'TOKEN_INVALIDO'],
    ['token vencido', { exp: 1 }, false, 401, 'TOKEN_INVALIDO'],
    [
      'emisor incorrecto',
      { iss: 'https://wrong.example' },
      false,
      401,
      'TOKEN_INVALIDO',
    ],
    ['audiencia ausente', { aud: undefined }, false, 401, 'TOKEN_INVALIDO'],
    ['audiencia incorrecta', { aud: 'other' }, false, 401, 'TOKEN_INVALIDO'],
    [
      'scope insuficiente',
      { scope: 'other' },
      false,
      403,
      'SCOPE_INSUFICIENTE',
    ],
    ['scope ausente', { scope: undefined }, false, 403, 'SCOPE_INSUFICIENTE'],
    [
      'tipo humano',
      { tipo: 'acceso', sub: randomUUID(), roles: [] },
      false,
      403,
      'SCOPE_INSUFICIENTE',
    ],
  ] as const)(
    '%s rechaza solicitudes',
    async (_name, claims, badSignature, status, code) => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/categorias')
        .set('Authorization', 'Bearer ' + token(claims, badSignature))
        .expect(status);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status, code });
    },
  );
});
