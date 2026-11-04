import { describe, expect, it } from 'vitest';
import type { IdentidadBaja } from './deactivation-check.js';
import {
  CharacteristicValueDomainService,
  ProductTypeCharacteristicDomainService,
  ProductTypeDomainService,
} from './entidades-maestras.js';

describe('reglas de baja de maestros pendientes', () => {
  it.each([
    ['PRODUCT_TYPE', new ProductTypeDomainService()],
    ['CHARACTERISTIC_VALUE', new CharacteristicValueDomainService()],
    [
      'PRODUCT_TYPE_CHARACTERISTIC',
      new ProductTypeCharacteristicDomainService(),
    ],
  ] as const)(
    'correlaciona %s, bloquea IN_USE e ignora respuestas obsoletas',
    (tipo, servicio) => {
      const asociacion =
        tipo === 'PRODUCT_TYPE_CHARACTERISTIC'
          ? { tipoProductoId: 'tipo', caracteristicaId: 'caracteristica' }
          : {};
      const identidad: IdentidadBaja = {
        operationId: 'operacion',
        correlationId: 'correlacion',
        entityType: tipo,
        entityId: 'entidad',
        version: 3,
        ...asociacion,
      };
      const actual = {
        id: 'entidad',
        estado: 'ACTIVO' as const,
        version: 3,
        ...asociacion,
      };
      const pendiente = servicio.admitir(actual, identidad);
      expect(pendiente).toEqual({ ...actual, estado: 'PENDING_DEACTIVATION' });
      if (!pendiente) throw new Error('No se admitió la operación');
      expect(
        servicio.evaluar(pendiente, identidad, {
          ...identidad,
          result: 'IN_USE',
        }),
      ).toEqual({
        estado: 'RECHAZADA',
        entidad: actual,
      });
      expect(
        servicio.evaluar(pendiente, identidad, {
          ...identidad,
          result: 'CLEAR',
        }),
      ).toEqual({
        estado: 'COMPLETADA',
        entidad: { ...actual, estado: 'INACTIVO', version: 4 },
      });
      expect(
        servicio.evaluar(pendiente, identidad, {
          ...identidad,
          version: 2,
          result: 'CLEAR',
        }),
      ).toEqual({ estado: 'IGNORADA' });
      expect(
        servicio.evaluar(pendiente, identidad, {
          ...identidad,
          correlationId: 'otra',
          result: 'CLEAR',
        }),
      ).toEqual({ estado: 'IGNORADA' });
      expect(
        servicio.admitir({ ...actual, estado: 'INACTIVO' }, identidad),
      ).toBeNull();
    },
  );

  it('usa la versión e identidades del tipo para la asociación', () => {
    const servicio = new ProductTypeCharacteristicDomainService();
    const identidad: IdentidadBaja = {
      operationId: 'op',
      correlationId: 'corr',
      entityType: 'PRODUCT_TYPE_CHARACTERISTIC',
      entityId: 'asociacion',
      version: 8,
      tipoProductoId: 'tipo',
      caracteristicaId: 'caracteristica',
    };
    const entidad = {
      id: 'asociacion',
      estado: 'ACTIVO' as const,
      version: 9,
      tipoProductoId: 'tipo',
      caracteristicaId: 'caracteristica',
    };
    expect(servicio.admitir(entidad, identidad)).toBeNull();
    expect(
      servicio.admitir(
        { ...entidad, version: 8, tipoProductoId: 'otro' },
        identidad,
      ),
    ).toBeNull();
  });
});
