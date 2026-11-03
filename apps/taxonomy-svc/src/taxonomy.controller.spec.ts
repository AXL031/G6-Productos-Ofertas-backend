import { Test, TestingModule } from '@nestjs/testing';
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

// Verifies actual Nest guard, JWT signature, JWKS and problem responses.
describe('listarCategorias y listarMarcas: seguridad HTTP contractual', () => {
  let server: Server;
  let app: INestApplication;
  let demoApp: INestApplication;
  let origin: string;
  const issuer = 'https://security.example.test';
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
        sub: 'catalog-svc',
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
      await request(demoApp.getHttpServer()).post(url).expect(404);
      await request(demoApp.getHttpServer())
        .get(url + '/desconocido')
        .expect(404);
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
