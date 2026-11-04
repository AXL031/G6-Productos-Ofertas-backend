import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { vi } from 'vitest';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { TaxonomyAdminQueryController } from './taxonomy-admin-query.controller.js';
import {
  TaxonomyCommercialGuard,
  TaxonomyTokenRejected,
  TaxonomyTokenVerifier,
  TaxonomyUserGuard,
} from './taxonomy-auth.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { MasterAdminQueryService } from './domain/master-admin-query.service.js';

describe('GET /api/v1/categorias/:categoriaId administrativo', () => {
  let app: INestApplication<App>;
  const verify = vi.fn();
  const repository = {
    findCategoriasActivas: vi.fn().mockResolvedValue([]),
    findMarcasActivas: vi.fn().mockResolvedValue([]),
    findCategoriaAdmin: vi.fn(),
  };
  const id = '11111111-1111-4111-8111-111111111111';
  const dto = {
    categoriaId: id,
    nombre: 'Calzado',
    descripcion: 'Calzado deportivo',
    categoriaPadreId: null,
    orden: 3,
    imagenUrl: 'https://cdn.example.test/calzado.webp',
    estado: 'ACTIVO',
    version: 7,
    slug: 'calzado',
  };
  const servicio = {
    kind: 'service',
    subject: 'modulo-productos',
    audiences: ['api-productos'],
    scopes: ['catalogo:leer'],
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TaxonomyAdminQueryController],
      providers: [
        TaxonomySvcService,
        TaxonomyUserGuard,
        TaxonomyCommercialGuard,
        { provide: TaxonomyTokenVerifier, useValue: { verify } },
        { provide: TAXONOMY_REPOSITORY, useValue: repository },
        {
          provide: MasterAdminQueryService,
          useValue: {
            arbol: vi.fn(),
            categoriasAdmin: vi.fn(),
            marca: vi.fn(),
            marcasAdmin: vi.fn(),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    verify.mockReset();
    repository.findCategoriaAdmin.mockReset();
    repository.findCategoriaAdmin.mockResolvedValue({
      id,
      nombre: dto.nombre,
      descripcion: dto.descripcion,
      categoria_padre_id: null,
      orden: dto.orden,
      imagen_url: dto.imagenUrl,
      estado: 'ACTIVO',
      version: dto.version,
      slug: dto.slug,
    });
  });

  it('devuelve el DTO administrativo exacto, incluido correlation id y valores persistidos', async () => {
    verify.mockResolvedValueOnce(servicio);
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer firmado')
      .set('X-Correlation-Id', '22222222-2222-4222-8222-222222222222')
      .expect(200)
      .expect(dto);
    expect(repository.findCategoriaAdmin).toHaveBeenCalledWith(id);
  });

  it('devuelve 404 CATEGORIA_NO_ENCONTRADA solo para una ausencia real', async () => {
    verify.mockResolvedValueOnce(servicio);
    repository.findCategoriaAdmin.mockResolvedValueOnce(undefined);
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer firmado')
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('CATEGORIA_NO_ENCONTRADA'));
  });

  it('rechaza ausencia de bearer, firma inválida, audience, cliente y scope', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .expect(401);
    verify.mockRejectedValueOnce(new TaxonomyTokenRejected());
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    verify.mockResolvedValueOnce({ ...servicio, audiences: ['otra'] });
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer wrong-aud')
      .expect(401);
    verify.mockResolvedValueOnce({ ...servicio, subject: 'otro' });
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer wrong-client')
      .expect(403);
    verify.mockResolvedValueOnce({ ...servicio, scopes: [] });
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer wrong-scope')
      .expect(403);
  });

  it('conserva el acceso userBearer y valida identificador/correlación', async () => {
    verify.mockResolvedValueOnce({
      kind: 'user',
      subject: id,
      roles: ['GESTOR_COMERCIAL'],
      audiences: ['api-productos'],
    });
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer usuario')
      .expect(200);
    verify.mockResolvedValueOnce({
      kind: 'user',
      subject: id,
      roles: [],
      audiences: ['api-productos'],
    });
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer usuario-sin-rol')
      .expect(403);
    verify.mockResolvedValueOnce({
      kind: 'user',
      subject: id,
      roles: ['GESTOR_COMERCIAL'],
      audiences: ['api-productos'],
    });
    verify.mockResolvedValueOnce({
      kind: 'user',
      subject: id,
      roles: ['GESTOR_COMERCIAL'],
      audiences: ['api-productos'],
    });
    await request(app.getHttpServer())
      .get('/api/v1/categorias/no-uuid')
      .set('Authorization', 'Bearer usuario')
      .expect(400);
    verify.mockResolvedValueOnce({
      kind: 'user',
      subject: id,
      roles: ['GESTOR_COMERCIAL'],
      audiences: ['api-productos'],
    });
    await request(app.getHttpServer())
      .get(`/api/v1/categorias/${id}`)
      .set('Authorization', 'Bearer usuario')
      .set('X-Correlation-Id', 'invalid')
      .expect(400);
  });
});
