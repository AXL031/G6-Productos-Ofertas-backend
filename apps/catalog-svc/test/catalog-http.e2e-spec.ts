import { Test } from '@nestjs/testing';
import {
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import {
  CatalogTokenRejected,
  CatalogTokenVerifier,
} from '../src/catalog-auth.js';
import { CatalogMutationService } from '../src/catalog-mutation.service.js';
import { CatalogQueryRepository } from '../src/catalog-query.repository.js';
import { CommercialService } from '../src/commercial.service.js';

describe('Catalog HTTP routes and security (isolated use-case fixtures)', () => {
  let app: INestApplication;
  const correlation = randomUUID();
  const variant = {
    variant_id: 'v',
    sku: '0000123',
    status: 'BORRADOR',
    identifying_attributes: [],
    non_identifying_attributes: [],
    images: [],
    physical_profile: null,
    catalog_version: 0,
  };
  const product = {
    product_id: 'p',
    slug: 'fixture',
    name: 'Fixture',
    categoria_id: 'cat',
    tipo_producto_id: 'type',
    marca_id: 'brand',
    tiene_variantes: false,
    status: 'BORRADOR',
    variants: [],
  };
  const mutations = {
    createProduct: vi.fn(async () => product),
    createVariant: vi.fn(async () => variant),
    update: vi.fn(async (_p: string, v?: string) => (v ? variant : product)),
    state: vi.fn(async (_p: string, v?: string) => (v ? variant : product)),
    retry: vi.fn(async () => ({
      operation_id: randomUUID(),
      status: 'ACCEPTED',
      correlation_id: correlation,
    })),
  };
  const queryRepository = {
    physicalData: vi.fn(async (skus: string[]) => ({
      productos: [],
      noEncontrados: skus,
    })),
    productPreparation: vi.fn(async () => ({
      product_id: 'p',
      tiene_variantes: false,
      pricing: { status: 'PENDING', manual_retry_allowed: false, code: null },
      inventario: {
        status: 'PENDING',
        manual_retry_allowed: false,
        code: null,
      },
      variantes: [],
    })),
    listVariants: vi.fn(async () => ({
      items: [variant],
      meta: { pagina: 1, tamanio: 20, total: 1, totalPaginas: 1 },
    })),
    findVariant: vi.fn(async () => variant),
  };
  const commercial = {
    list: vi.fn(async () => ({ items: [], pagina: 1, tamanio: 20, total: 0 })),
    detail: vi.fn(async () => ({
      product_id: product.product_id,
      slug: product.slug,
      name: product.name,
      categoria_id: product.categoria_id,
      tipo_producto_id: product.tipo_producto_id,
      marca_id: product.marca_id,
      tiene_variantes: product.tiene_variantes,
      variants: [],
      marca: { marca_id: 'brand', name: 'Brand' },
    })),
    productById: vi.fn(async () => ({
      product_id: product.product_id,
      slug: product.slug,
      name: product.name,
      categoria_id: product.categoria_id,
      tipo_producto_id: product.tipo_producto_id,
      marca_id: product.marca_id,
      tiene_variantes: product.tiene_variantes,
      variants: [],
      marca: { marca_id: 'brand', name: 'Brand' },
    })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CatalogMutationService)
      .useValue(mutations)
      .overrideProvider(CatalogQueryRepository)
      .useValue(queryRepository)
      .overrideProvider(CommercialService)
      .useValue(commercial)
      .overrideProvider(CatalogTokenVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'manager')
            return {
              kind: 'user',
              subject: randomUUID(),
              roles: ['GESTOR_COMERCIAL'],
            };
          if (token === 'viewer')
            return { kind: 'user', subject: randomUUID(), roles: [] };
          const clients: Record<string, string> = {
            channel: 'modulo-marketplace',
            dispatch: 'modulo-despacho',
            retail: 'modulo-retail',
          };
          if (clients[token])
            return {
              kind: 'service',
              subject: clients[token],
              audiences: ['api-productos'],
              scopes:
                token === 'dispatch'
                  ? ['productos:fisicos:leer']
                  : ['catalogo:leer'],
            };
          throw new CatalogTokenRejected();
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ['/productos', 'list'],
    ['/productos/p', 'productById'],
    ['/productos/por-slug/fixture', 'detail'],
  ] as const)(
    'allows a human query without a channel at %s',
    async (path, method) => {
      await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer manager')
        .expect(200);
      expect(commercial[method]).toHaveBeenCalledOnce();
      for (const bearer of ['channel', 'dispatch']) {
        const response = await request(app.getHttpServer())
          .get('/api/v1' + path)
          .set('Authorization', 'Bearer ' + bearer);
        expect(response.status).toBe(bearer === 'channel' ? 400 : 403);
      }
    },
  );
  const writes = [
    ['post', '/productos', {}, 201, 'createProduct'],
    ['patch', '/productos/p', {}, 200, 'update'],
    ['post', '/productos/p/activar', {}, 200, 'state'],
    ['post', '/productos/p/desactivar', {}, 200, 'state'],
    ['post', '/productos/p/reactivar', {}, 200, 'state'],
    [
      'post',
      '/productos/p/preparacion/reintentar',
      { dependencia: 'PRICING' },
      202,
      'retry',
    ],
    ['post', '/productos/p/variantes', {}, 201, 'createVariant'],
    ['patch', '/productos/p/variantes/v', {}, 200, 'update'],
    ['post', '/productos/p/variantes/v/activar', {}, 200, 'state'],
    ['post', '/productos/p/variantes/v/desactivar', {}, 200, 'state'],
    ['post', '/productos/p/variantes/v/reactivar', {}, 200, 'state'],
    [
      'post',
      '/productos/p/variantes/v/preparacion/reintentar',
      {},
      202,
      'retry',
    ],
  ] as const;
  it.each(writes)(
    'registers and authorizes %s %s with contractual success status',
    async (method, path, body, status, useCase) => {
      const response = await request(app.getHttpServer())
        [method]('/api/v1' + path)
        .set('Authorization', 'Bearer manager')
        .set('X-Correlation-Id', correlation)
        .send(body)
        .expect(status);
      expect(mutations[useCase]).toHaveBeenCalledOnce();
      if (status === 202)
        expect(response.body).toMatchObject({
          status: 'ACCEPTED',
          correlation_id: correlation,
        });
      else
        expect(response.body).toHaveProperty(
          path.includes('/variantes') ? 'variant_id' : 'product_id',
        );
    },
  );
  const reads = [
    ['get', '/productos?canal=MARKETPLACE', 'dispatch'],
    ['get', '/productos/p?canal=MARKETPLACE', 'dispatch'],
    ['get', '/productos/por-slug/fixture?canal=MARKETPLACE', 'dispatch'],
    ['get', '/productos/p/preparacion', 'channel'],
    ['get', '/productos/p/variantes', 'channel'],
    ['get', '/productos/p/variantes/v', 'channel'],
    ['post', '/productos/datos-fisicos/consulta', 'manager'],
    ['post', '/productos/codigos-barras/resolver', 'channel'],
  ] as const;
  it.each(reads)(
    'protects read operation %s %s before executing its use case',
    async (method, path, wrongIdentity) => {
      for (const bearer of [undefined, 'invalid', wrongIdentity]) {
        const call = request(app.getHttpServer())[method]('/api/v1' + path);
        if (bearer) call.set('Authorization', 'Bearer ' + bearer);
        const status = bearer === wrongIdentity ? 403 : 401;
        const result = await call
          .set('X-Correlation-Id', correlation)
          .expect(status);
        expect(result.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(result.body).toMatchObject({
          status,
          code: status === 401 ? 'TOKEN_INVALIDO' : 'SCOPE_INSUFICIENTE',
          correlationId: correlation,
        });
      }
      for (const useCase of [
        ...Object.values(commercial),
        ...Object.values(queryRepository),
        ...Object.values(mutations),
      ])
        expect(useCase).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['/productos?canal=MARKETPLACE&canal=RETAIL', 'channel'],
    ['/productos?canal=MARKETPLACE&pagina=1&pagina=2', 'channel'],
    ['/productos?canal=MARKETPLACE&unknown=1', 'channel'],
    ['/productos/p/variantes?pagina=1&pagina=2', 'manager'],
    ['/productos/p/variantes?unknown=1', 'manager'],
  ])(
    'rejects duplicate or unsupported query parameters at %s',
    async (path, bearer) => {
      const result = await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer ' + bearer)
        .expect(400);
      expect(result.body.code).toBe('VALIDACION');
      expect(commercial.list).not.toHaveBeenCalled();
      expect(queryRepository.listVariants).not.toHaveBeenCalled();
    },
  );
  it('keeps read dependency failures sanitized and never invokes a mutation', async () => {
    queryRepository.productPreparation.mockRejectedValueOnce(
      new ServiceUnavailableException('private SQL and token'),
    );
    const result = await request(app.getHttpServer())
      .get('/api/v1/productos/p/preparacion')
      .set('Authorization', 'Bearer manager')
      .set('X-Correlation-Id', correlation)
      .expect(503);
    expect(result.body).toMatchObject({
      code: 'SERVICIO_NO_DISPONIBLE',
      correlationId: correlation,
    });
    expect(JSON.stringify(result.body)).not.toMatch(/private|SQL|token/);
    for (const mutation of Object.values(mutations))
      expect(mutation).not.toHaveBeenCalled();
  });
  it.each(writes)(
    'rejects unauthenticated and unauthorized callers of %s %s',
    async (method, path, body, _status, useCase) => {
      const missing = await request(app.getHttpServer())
        [method]('/api/v1' + path)
        .send(body)
        .expect(401);
      expect(missing.body.code).toBe('TOKEN_INVALIDO');
      for (const token of ['viewer', 'channel']) {
        const response = await request(app.getHttpServer())
          [method]('/api/v1' + path)
          .set('Authorization', 'Bearer ' + token)
          .send(body)
          .expect(403);
        expect(response.body.code).toBe('SCOPE_INSUFICIENTE');
      }
      expect(mutations[useCase]).not.toHaveBeenCalled();
    },
  );
  it('exercises all eight read operationIds and preserves the blocked barcode boundary', async () => {
    for (const path of [
      '/productos?canal=MARKETPLACE',
      '/productos/p?canal=MARKETPLACE',
      '/productos/por-slug/fixture?canal=MARKETPLACE',
    ])
      await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer channel')
        .expect(200);
    for (const path of [
      '/productos/p/preparacion',
      `/productos/${correlation}/variantes`,
      `/productos/${correlation}/variantes/${correlation}`,
    ])
      await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer manager')
        .expect(200);
    const physical = await request(app.getHttpServer())
      .post('/api/v1/productos/datos-fisicos/consulta')
      .set('Authorization', 'Bearer dispatch')
      .send({ skus: ['0000123'] })
      .expect(200);
    expect(physical.body).toEqual({
      productos: [],
      noEncontrados: ['0000123'],
    });
    const barcode = await request(app.getHttpServer())
      .post('/api/v1/productos/codigos-barras/resolver')
      .set('Authorization', 'Bearer retail')
      .send({ codigo_barras: '0000123' })
      .expect(503);
    expect(barcode.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });
  it('denies wrong client/scope and rejects malformed product detail query parameters', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/productos/datos-fisicos/consulta')
      .set('Authorization', 'Bearer channel')
      .send({ skus: ['000'] })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/productos/p/preparacion')
      .set('Authorization', 'Bearer viewer')
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/productos/p?canal=MARKETPLACE&invented=1')
      .set('Authorization', 'Bearer channel')
      .expect(400);
  });
  it.each([
    '/productos/not-a-uuid/variantes',
    `/productos/${correlation}/variantes/not-a-uuid`,
    `/productos/${correlation}/variantes?pagina=0`,
    `/productos/${correlation}/variantes?tamanio=201`,
    `/productos/${correlation}/variantes?estado=ACTIVO`,
    `/productos/${correlation}/variantes?pagina=1&pagina=2`,
    `/productos/${correlation}/variantes?pagina[]=1`,
    `/productos/${correlation}/variantes?unknown=1`,
    `/productos/${correlation}/variantes/${correlation}?unknown=1`,
    `/productos/${correlation}/variantes/${correlation}?pagina=1&pagina=2`,
  ])('returns contractual 400 before reading variants: %s', async (path) => {
    const response = await request(app.getHttpServer())
      .get('/api/v1' + path)
      .set('Authorization', 'Bearer manager')
      .expect(400);
    expect(response.type).toBe('application/problem+json');
    expect(response.body.code).toBe('VALIDACION');
    expect(queryRepository.listVariants).not.toHaveBeenCalled();
    expect(queryRepository.findVariant).not.toHaveBeenCalled();
  });
  it('keeps valid absent identities at 404 and rejects invalid correlation at 400', async () => {
    queryRepository.listVariants.mockResolvedValueOnce(null as never);
    queryRepository.findVariant.mockResolvedValueOnce(null as never);
    for (const [path, code] of [
      [`/productos/${correlation}/variantes`, 'PRODUCTO_NO_ENCONTRADO'],
      [
        `/productos/${correlation}/variantes/${correlation}`,
        'VARIANTE_NO_ENCONTRADA',
      ],
    ]) {
      const response = await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer manager')
        .expect(404);
      expect(response.body.code).toBe(code);
      await request(app.getHttpServer())
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer manager')
        .set('X-Correlation-Id', 'invalid')
        .expect(400);
    }
  });
});
