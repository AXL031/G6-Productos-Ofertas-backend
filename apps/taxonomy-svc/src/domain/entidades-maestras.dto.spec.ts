import { describe, expect, it } from 'vitest';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';
import {
  validarAsociacionCreate,
  validarAsociacionUpdate,
  validarTipoProductoCreate,
  validarValorCaracteristicaWrite,
} from './entidades-maestras.dto.js';

describe('validación de DTOs de maestros', () => {
  it('acepta campos contractuales y propiedades adicionales', () => {
    expect(
      validarTipoProductoCreate({ nombre: 'Calzado', extra: true }),
    ).toEqual({ nombre: 'Calzado' });
    expect(
      validarValorCaracteristicaWrite({ nombre: 'Rojo', version: null }),
    ).toEqual({ nombre: 'Rojo', version: null });
    expect(
      validarAsociacionCreate({
        caracteristicaId: '11111111-1111-4111-8111-111111111111',
        obligatoria: true,
      }),
    ).toMatchObject({ obligatoria: true });
    expect(
      validarAsociacionUpdate({ obligatoria: false, schemaVersion: 2 }),
    ).toEqual({ obligatoria: false, schemaVersion: 2 });
  });
  it('solo conserva obligatoriedad en el DTO de la asociación', () => {
    expect(
      validarTipoProductoCreate({ nombre: 'Calzado', obligatoria: true }),
    ).toEqual({ nombre: 'Calzado' });
    expect(
      validarValorCaracteristicaWrite({ nombre: 'Rojo', obligatoria: true }),
    ).toEqual({ nombre: 'Rojo', version: undefined });
    expect(
      validarAsociacionCreate({ caracteristicaId: 'id', obligatoria: true }),
    ).toMatchObject({ obligatoria: true });
  });
  it.each([
    () => validarTipoProductoCreate({ nombre: '' }),
    () => validarValorCaracteristicaWrite({ nombre: 'x', version: -1 }),
    () =>
      validarAsociacionCreate({
        caracteristicaId: 42,
        obligatoria: true,
      }),
    () => validarAsociacionUpdate({ obligatoria: true }),
    () => validarAsociacionUpdate({ obligatoria: 'false', schemaVersion: 1 }),
  ])('reporta validación mediante Problem Details', (validar) => {
    try {
      validar();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemDetailsException);
      expect((error as ProblemDetailsException).problem).toMatchObject({
        status: 400,
        code: 'VALIDACION',
      });
    }
  });
});
