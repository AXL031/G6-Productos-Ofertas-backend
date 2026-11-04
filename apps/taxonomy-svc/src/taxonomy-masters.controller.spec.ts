import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { vi } from 'vitest';
import { TaxonomyMastersController } from './taxonomy-masters.controller.js';
import {
  TaxonomyUserGuard,
  TaxonomyCommercialGuard,
  TaxonomyTokenVerifier,
  TaxonomyTokenRejected,
} from './taxonomy-auth.js';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { ProductTypeService } from './domain/product-type.service.js';
import { CharacteristicValueService } from './domain/characteristic-value.service.js';
import { ProductTypeCharacteristicService } from './domain/product-type-characteristic.service.js';
import { MasterDeactivationRequestService } from './domain/master-deactivation-request.service.js';

describe('rutas HTTP de maestros', () => {
  let app: INestApplication;
  const id = '11111111-1111-4111-8111-111111111111';
  const correlation = '22222222-2222-4222-8222-222222222222';
  const tipos = { obtener: vi.fn(), crear: vi.fn(), listar: vi.fn() };
  const valores = { listar: vi.fn(), crear: vi.fn() };
  const asociaciones = { listar: vi.fn(), crear: vi.fn(), actualizar: vi.fn() };
  const bajas = { solicitar: vi.fn() };
  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [TaxonomyMastersController],
      providers: [
        { provide: ProductTypeService, useValue: tipos },
        { provide: CharacteristicValueService, useValue: valores },
        { provide: ProductTypeCharacteristicService, useValue: asociaciones },
        { provide: MasterDeactivationRequestService, useValue: bajas },
      ],
    })
      .overrideGuard(TaxonomyUserGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TaxonomyCommercialGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = modulo.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => vi.resetAllMocks());

  it('expone creación de tipo y consulta de valores', async () => {
    tipos.crear.mockResolvedValue({
      tipoProductoId: id,
      nombre: 'Calzado',
      estado: 'ACTIVO',
      schemaVersion: 1,
    });
    await request(app.getHttpServer())
      .post('/api/v1/tipos-producto')
      .send({ nombre: 'Calzado' })
      .expect(201);
    valores.listar.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(`/api/v1/caracteristicas/${id}/valores`)
      .expect(200, []);
  });
  it.each([
    ['/api/v1/tipos-producto/' + id + '/desactivar', 'PRODUCT_TYPE'],
    [
      '/api/v1/caracteristicas/' + id + '/valores/' + id + '/desactivar',
      'CHARACTERISTIC_VALUE',
    ],
    [
      '/api/v1/tipos-producto/' + id + '/caracteristicas/' + id + '/desasociar',
      'PRODUCT_TYPE_CHARACTERISTIC',
    ],
  ])(
    'admite %s por POST sin confundir admisión y resultado',
    async (ruta, tipo) => {
      bajas.solicitar.mockResolvedValue({
        estado: 'ACEPTADA',
        operation_id: id,
        correlation_id: correlation,
        status: 'ACCEPTED',
      });
      const respuesta = await request(app.getHttpServer())
        .post(ruta)
        .set('X-Correlation-Id', correlation)
        .expect(202);
      expect(respuesta.body).toEqual({
        operation_id: id,
        correlation_id: correlation,
        status: 'ACCEPTED',
      });
      expect(bajas.solicitar).toHaveBeenCalledWith(
        expect.objectContaining({ tipo }),
        correlation,
      );
    },
  );
  it('devuelve Problem Details ante entrada inválida', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/tipos-producto')
      .send({ nombre: '' })
      .expect(400);
    expect(respuesta.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(respuesta.body.code).toBe('VALIDACION');
  });
  it('valida y actualiza la obligatoriedad con control de versión', async () => {
    const path = `/api/v1/tipos-producto/${id}/caracteristicas/${id}`;
    asociaciones.actualizar.mockResolvedValueOnce({
      estado: 'OK',
      asociacion: { caracteristicaId: id, obligatoria: true, schemaVersion: 3 },
    });
    await request(app.getHttpServer())
      .patch(path)
      .send({ obligatoria: true, schemaVersion: 2 })
      .expect(200);
    expect(asociaciones.actualizar).toHaveBeenCalledWith(
      id,
      id,
      true,
      2,
      undefined,
    );
    asociaciones.actualizar.mockResolvedValueOnce({
      estado: 'VERSION_CONFLICT',
    });
    await request(app.getHttpServer())
      .patch(path)
      .send({ obligatoria: false, schemaVersion: 2 })
      .expect(409);
    await request(app.getHttpServer())
      .patch(path)
      .send({ obligatoria: true })
      .expect(400);
  });
});

describe('autorización HTTP de escritura de maestros', () => {
  let app: INestApplication;
  const verificar = vi.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TaxonomyMastersController],
      providers: [
        TaxonomyUserGuard,
        TaxonomyCommercialGuard,
        { provide: TaxonomyTokenVerifier, useValue: { verify: verificar } },
        {
          provide: ProductTypeService,
          useValue: {
            crear: vi.fn().mockResolvedValue({ nombre: 'Calzado' }),
            listar: vi.fn().mockResolvedValue({ items: [] }),
          },
        },
        { provide: CharacteristicValueService, useValue: {} },
        { provide: ProductTypeCharacteristicService, useValue: {} },
        { provide: MasterDeactivationRequestService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  it('solo admite Catalog con audiencia y scope existentes para lecturas de servicio', async () => {
    const get = () =>
      request(app.getHttpServer()).get('/api/v1/tipos-producto');
    await get().expect(401);
    const service = {
      kind: 'service',
      subject: 'catalog-svc',
      audiences: ['api-productos'],
      scopes: ['catalogo:leer'],
    };
    verificar.mockResolvedValueOnce({ ...service, audiences: ['otra'] });
    await get().set('Authorization', 'Bearer servicio').expect(401);
    verificar.mockResolvedValueOnce({ ...service, subject: 'otro' });
    await get().set('Authorization', 'Bearer servicio').expect(403);
    verificar.mockResolvedValueOnce({ ...service, scopes: [] });
    await get().set('Authorization', 'Bearer servicio').expect(403);
    verificar.mockResolvedValueOnce(service);
    await get().set('Authorization', 'Bearer servicio').expect(200);
    verificar.mockResolvedValueOnce({
      kind: 'user',
      audiences: ['api-productos'],
      roles: [],
    });
    await get().set('Authorization', 'Bearer humano').expect(200);
  });
  it('requiere bearer y rol comercial en escritura', async () => {
    const post = () =>
      request(app.getHttpServer())
        .post('/api/v1/tipos-producto')
        .send({ nombre: 'Calzado' });
    await post().expect(401);
    verificar.mockRejectedValueOnce(new TaxonomyTokenRejected());
    await post().set('Authorization', 'Bearer invalido').expect(401);
    verificar.mockResolvedValueOnce({
      kind: 'user',
      audiences: ['api-productos'],
      roles: [],
    });
    await post().set('Authorization', 'Bearer usuario').expect(403);
    verificar.mockResolvedValueOnce({
      kind: 'service',
      audiences: ['api-productos'],
      scopes: ['catalogo:leer'],
    });
    await post().set('Authorization', 'Bearer servicio').expect(403);
    verificar.mockResolvedValueOnce({
      kind: 'user',
      audiences: ['api-productos'],
      roles: ['GESTOR_COMERCIAL'],
    });
    await post().set('Authorization', 'Bearer gestor').expect(201);
  });
});
