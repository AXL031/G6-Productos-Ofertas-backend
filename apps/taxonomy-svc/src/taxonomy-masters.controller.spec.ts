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
import { CharacteristicService } from './domain/characteristic.service.js';
import { DeactivationIntentService } from './domain/deactivation-intent.service.js';

describe('rutas HTTP de maestros', () => {
  let app: INestApplication;
  const id = '11111111-1111-4111-8111-111111111111';
  const correlation = '22222222-2222-4222-8222-222222222222';
  const tipos = {
    obtener: vi.fn(),
    obtenerEsquema: vi.fn(),
    crear: vi.fn(),
    listar: vi.fn(),
  };
  const valores = { listar: vi.fn(), crear: vi.fn() };
  const asociaciones = { listar: vi.fn(), crear: vi.fn(), actualizar: vi.fn() };
  const bajas = { solicitar: vi.fn() };
  const caracteristicas = {
    listar: vi.fn(),
    crear: vi.fn(),
    obtener: vi.fn(),
    actualizar: vi.fn(),
    cambiarEstado: vi.fn(),
  };
  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [TaxonomyMastersController],
      providers: [
        { provide: ProductTypeService, useValue: tipos },
        { provide: CharacteristicValueService, useValue: valores },
        { provide: ProductTypeCharacteristicService, useValue: asociaciones },
        { provide: MasterDeactivationRequestService, useValue: bajas },
        { provide: CharacteristicService, useValue: caracteristicas },
        {
          provide: DeactivationIntentService,
          useValue: { obtenerOperacion: vi.fn() },
        },
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
  it.each([undefined, ''])(
    'distingue unidad NUMERO ausente o vacía',
    async (unidadMedida) => {
      const respuesta = await request(app.getHttpServer())
        .post('/api/v1/caracteristicas')
        .send({ nombre: 'Peso', tipo: 'NUMERO', unidadMedida })
        .expect(422);
      expect(respuesta.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(respuesta.body.code).toBe('VALOR_NUMERICO_INVALIDO');
      expect(caracteristicas.crear).not.toHaveBeenCalled();
    },
  );
  it('trata tipos de unidad estructuralmente inválidos como VALIDACION', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/caracteristicas')
      .send({ nombre: 'Peso', tipo: 'NUMERO', unidadMedida: 42 })
      .expect(400);
    expect(respuesta.body.code).toBe('VALIDACION');
    expect(caracteristicas.crear).not.toHaveBeenCalled();
  });
  it('rechaza unidad incompatible con TEXTO mediante VALIDACION', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/caracteristicas')
      .send({ nombre: 'Color', tipo: 'TEXTO', unidadMedida: 'kg' })
      .expect(400);
    expect(respuesta.body.code).toBe('VALIDACION');
    expect(caracteristicas.crear).not.toHaveBeenCalled();
  });
  it.each([null, ''])(
    'mapea unidad NUMERO inválida en PATCH a 422',
    async (unidadMedida) => {
      caracteristicas.actualizar.mockResolvedValueOnce('INVALIDA');
      const respuesta = await request(app.getHttpServer())
        .patch(`/api/v1/caracteristicas/${id}`)
        .send({ unidadMedida, version: 0 })
        .expect(422);
      expect(respuesta.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(respuesta.body.code).toBe('VALOR_NUMERICO_INVALIDO');
    },
  );
  it('mapea unidad incompatible en PATCH a 400 VALIDACION', async () => {
    caracteristicas.actualizar.mockResolvedValueOnce('UNIDAD_INCOMPATIBLE');
    const respuesta = await request(app.getHttpServer())
      .patch(`/api/v1/caracteristicas/${id}`)
      .send({ unidadMedida: 'kg', version: 0 })
      .expect(400);
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
  const tipoService = {
    crear: vi.fn().mockResolvedValue({ nombre: 'Calzado' }),
    listar: vi.fn().mockResolvedValue({ items: [] }),
    obtenerEsquema: vi.fn().mockResolvedValue({ caracteristicas: [] }),
    obtener: vi.fn().mockResolvedValue({
      tipoProductoId: '11111111-1111-4111-8111-111111111111',
      estado: 'ACTIVO',
    }),
  };
  const caracteristicaService = {
    obtener: vi.fn().mockResolvedValue({
      caracteristicaId: '11111111-1111-4111-8111-111111111111',
      nombre: 'Color',
      estado: 'ACTIVO',
    }),
  };
  const valoresService = { listar: vi.fn().mockResolvedValue([]) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TaxonomyMastersController],
      providers: [
        TaxonomyUserGuard,
        TaxonomyCommercialGuard,
        { provide: TaxonomyTokenVerifier, useValue: { verify: verificar } },
        { provide: ProductTypeService, useValue: tipoService },
        { provide: CharacteristicValueService, useValue: valoresService },
        { provide: ProductTypeCharacteristicService, useValue: {} },
        { provide: MasterDeactivationRequestService, useValue: {} },
        { provide: CharacteristicService, useValue: caracteristicaService },
        {
          provide: DeactivationIntentService,
          useValue: { obtenerOperacion: vi.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    verificar.mockReset();
    tipoService.obtener.mockReset().mockResolvedValue({
      tipoProductoId: '11111111-1111-4111-8111-111111111111',
      estado: 'ACTIVO',
    });
    caracteristicaService.obtener.mockReset().mockResolvedValue({
      caracteristicaId: '11111111-1111-4111-8111-111111111111',
      nombre: 'Color',
      estado: 'ACTIVO',
    });
    valoresService.listar.mockReset().mockResolvedValue([]);
  });
  it('limita modulo-productos a las lecturas autorizadas', async () => {
    const get = () =>
      request(app.getHttpServer()).get('/api/v1/tipos-producto');
    await get().expect(401);
    verificar.mockRejectedValueOnce(new TaxonomyTokenRejected());
    await get().set('Authorization', 'Bearer invalido').expect(401);
    const service = {
      kind: 'service',
      subject: 'modulo-productos',
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
    const id = '11111111-1111-4111-8111-111111111111';
    verificar.mockResolvedValueOnce(service);
    tipoService.obtenerEsquema.mockResolvedValueOnce({
      tipoProducto: { estado: 'ACTIVO' },
      caracteristicas: [],
      schemaVersion: 1,
    });
    await request(app.getHttpServer())
      .get(`/api/v1/tipos-producto/${id}/caracteristicas`)
      .set('Authorization', 'Bearer servicio')
      .expect(200);
    verificar.mockResolvedValueOnce(service);
    await request(app.getHttpServer())
      .get(`/api/v1/tipos-producto/${id}`)
      .set('Authorization', 'Bearer servicio')
      .expect(200);
    verificar.mockResolvedValueOnce(service);
    await request(app.getHttpServer())
      .get(`/api/v1/caracteristicas/${id}`)
      .set('Authorization', 'Bearer servicio')
      .expect(200);
    verificar.mockResolvedValueOnce(service);
    await request(app.getHttpServer())
      .get(`/api/v1/caracteristicas/${id}/valores`)
      .set('Authorization', 'Bearer servicio')
      .expect(200, []);
    verificar.mockResolvedValueOnce({ ...service, subject: 'catalog-svc' });
    await get().set('Authorization', 'Bearer servicio').expect(403);
    verificar.mockResolvedValueOnce({
      kind: 'user',
      audiences: ['api-productos'],
      roles: [],
    });
    await get().set('Authorization', 'Bearer cliente').expect(403);
    verificar.mockResolvedValueOnce({
      kind: 'user',
      audiences: [],
      roles: ['GESTOR_COMERCIAL'],
    });
    await get().set('Authorization', 'Bearer gestor').expect(200);
  });
  it('permite al gestor consultar detalles y deniega el detalle de característica a otros usuarios', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const gestor = {
      kind: 'user',
      subject: id,
      audiences: ['api-productos'],
      roles: ['GESTOR_COMERCIAL'],
    } as const;
    verificar.mockResolvedValueOnce(gestor);
    await request(app.getHttpServer())
      .get(`/api/v1/caracteristicas/${id}`)
      .set('Authorization', 'Bearer gestor')
      .expect(200);
    verificar.mockResolvedValueOnce({ ...gestor, roles: [] });
    await request(app.getHttpServer())
      .get(`/api/v1/caracteristicas/${id}`)
      .set('Authorization', 'Bearer usuario')
      .expect(403);
    verificar.mockResolvedValueOnce(gestor);
    await request(app.getHttpServer())
      .get(`/api/v1/tipos-producto/${id}`)
      .set('Authorization', 'Bearer gestor')
      .expect(200);
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
      kind: 'service',
      subject: 'modulo-productos',
      audiences: ['api-productos'],
      scopes: ['catalogo:leer'],
    });
    await request(app.getHttpServer())
      .patch('/api/v1/caracteristicas/11111111-1111-4111-8111-111111111111')
      .set('Authorization', 'Bearer servicio')
      .send({ nombre: 'Nuevo', version: 0 })
      .expect(403);
    verificar.mockResolvedValueOnce({
      kind: 'user',
      audiences: ['api-productos'],
      roles: ['GESTOR_COMERCIAL'],
    });
    tipoService.crear.mockResolvedValueOnce({ nombre: 'Calzado' });
    const response = await post().set('Authorization', 'Bearer gestor');
    expect(response.status).toBe(201);
  });
  it('rechaza token expirado o con firma inválida y conserva 404 contractual', async () => {
    for (const token of ['Bearer expirado', 'Bearer firma-invalida']) {
      verificar.mockRejectedValueOnce(new TaxonomyTokenRejected());
      await request(app.getHttpServer())
        .get('/api/v1/tipos-producto/11111111-1111-4111-8111-111111111111')
        .set('Authorization', token)
        .expect(401);
    }
    const service = {
      kind: 'service',
      subject: 'modulo-productos',
      audiences: ['api-productos'],
      scopes: ['catalogo:leer'],
    };
    tipoService.obtener.mockResolvedValueOnce(null);
    verificar.mockResolvedValueOnce(service);
    const tipoInexistente = await request(app.getHttpServer())
      .get('/api/v1/tipos-producto/11111111-1111-4111-8111-111111111111')
      .set('Authorization', 'Bearer servicio');
    expect(tipoInexistente.status).toBe(404);
    expect(tipoInexistente.headers['content-type']).toContain(
      'application/problem+json',
    );
    caracteristicaService.obtener.mockResolvedValueOnce(null);
    verificar.mockResolvedValueOnce(service);
    const caracteristicaInexistente = await request(app.getHttpServer())
      .get('/api/v1/caracteristicas/11111111-1111-4111-8111-111111111111')
      .set('Authorization', 'Bearer servicio');
    expect(caracteristicaInexistente.status).toBe(404);
    expect(caracteristicaInexistente.headers['content-type']).toContain(
      'application/problem+json',
    );
  });
});
