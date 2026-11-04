import { describe, expect, it } from 'vitest';
import {
  evaluarCheckBaja,
  type IdentidadBaja,
  type TipoMaestro,
} from './deactivation-check.js';

const base: IdentidadBaja = {
  operationId: 'op-1',
  correlationId: 'corr-1',
  entityType: 'CATEGORY',
  entityId: 'entidad-1',
  version: 2,
};

describe('DEC-G6-INT-05: evaluación interna del check de baja', () => {
  it.each<TipoMaestro>([
    'CATEGORY',
    'BRAND',
    'PRODUCT_TYPE',
    'CHARACTERISTIC_VALUE',
    'PRODUCT_TYPE_CHARACTERISTIC',
  ])('evalúa CLEAR vigente para %s sin confirmar la baja', (entityType) => {
    const identidad: IdentidadBaja = {
      ...base,
      entityType,
      ...(entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
        ? { tipoProductoId: 'tipo-1', caracteristicaId: 'caracteristica-1' }
        : {}),
    };
    expect(evaluarCheckBaja(identidad, { ...identidad, result: 'CLEAR' })).toBe(
      'EVALUAR_BAJA',
    );
    expect(
      evaluarCheckBaja(identidad, { ...identidad, result: 'IN_USE' }),
    ).toBe('RECHAZAR_BAJA');
  });

  it.each([
    { operationId: 'otra' },
    { correlationId: 'otra' },
    { entityType: 'BRAND' as const },
    { entityId: 'otra' },
    { version: 1 },
  ])(
    'ignora respuesta no correlacionada o con versión obsoleta: %j',
    (cambio) => {
      expect(
        evaluarCheckBaja(base, { ...base, ...cambio, result: 'CLEAR' }),
      ).toBe('IGNORAR');
    },
  );

  it.each(['HAS_ACTIVE_PRODUCTS', 'ERROR', null, undefined])(
    'no convierte %s en resultado válido',
    (result) => {
      expect(evaluarCheckBaja(base, { ...base, result })).toBe('IGNORAR');
    },
  );

  it('exige y correlaciona ambas identidades de la asociación', () => {
    const asociacion: IdentidadBaja = {
      ...base,
      entityType: 'PRODUCT_TYPE_CHARACTERISTIC',
      tipoProductoId: 'tipo-1',
      caracteristicaId: 'caracteristica-1',
    };
    expect(
      evaluarCheckBaja(asociacion, {
        ...asociacion,
        caracteristicaId: 'otra',
        result: 'CLEAR',
      }),
    ).toBe('IGNORAR');
    expect(
      evaluarCheckBaja(
        { ...asociacion, tipoProductoId: undefined },
        { ...asociacion, result: 'CLEAR' },
      ),
    ).toBe('IGNORAR');
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'ignora versión autoritativa inválida %s',
    (version) => {
      const identidad = { ...base, version };
      expect(
        evaluarCheckBaja(identidad, { ...identidad, result: 'CLEAR' }),
      ).toBe('IGNORAR');
    },
  );
});
