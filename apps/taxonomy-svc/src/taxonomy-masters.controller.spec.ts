import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { vi } from 'vitest';
import { TaxonomyMastersController } from './taxonomy-masters.controller.js';
import { TaxonomyUserGuard } from './taxonomy-auth.js';
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
  const asociaciones = { listar: vi.fn(), crear: vi.fn() };
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
});
