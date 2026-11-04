import { ProblemDetailsException } from '../errors/taxonomy.errors.js';

export interface TipoProductoCreateRequest {
  nombre: string;
}
export interface ValorCaracteristicaWriteRequest {
  nombre: string;
  version?: number | null;
}
export interface AsociacionTipoCaracteristicaCreateRequest {
  caracteristicaId: string;
  obligatoria: boolean;
  schemaVersion?: number | null;
}
export interface AsociacionTipoCaracteristicaUpdateRequest {
  obligatoria: boolean;
  schemaVersion: number;
}

function objeto(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw ProblemDetailsException.validacion('Cuerpo inválido.');
  return body as Record<string, unknown>;
}
function nombre(valor: unknown): string {
  if (typeof valor !== 'string' || valor.trim().length === 0)
    throw ProblemDetailsException.validacion(
      'nombre debe ser una cadena no vacía.',
    );
  return valor;
}
function version(valor: unknown, opcional: boolean): number | null | undefined {
  if (opcional && (valor === undefined || valor === null)) return valor;
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < 0)
    throw ProblemDetailsException.validacion(
      'La versión debe ser un entero no negativo.',
    );
  return valor;
}
function obligatorio(valor: unknown): boolean {
  if (typeof valor !== 'boolean')
    throw ProblemDetailsException.validacion('obligatoria debe ser booleano.');
  return valor;
}
export function validarTipoProductoCreate(
  body: unknown,
): TipoProductoCreateRequest {
  const datos = objeto(body);
  return { nombre: nombre(datos.nombre) };
}
export function validarValorCaracteristicaWrite(
  body: unknown,
): ValorCaracteristicaWriteRequest {
  const datos = objeto(body);
  return {
    nombre: nombre(datos.nombre),
    version: version(datos.version, true),
  };
}
export function validarAsociacionCreate(
  body: unknown,
): AsociacionTipoCaracteristicaCreateRequest {
  const datos = objeto(body);
  if (typeof datos.caracteristicaId !== 'string')
    throw ProblemDetailsException.validacion(
      'caracteristicaId debe ser una cadena.',
    );
  return {
    caracteristicaId: datos.caracteristicaId,
    obligatoria: obligatorio(datos.obligatoria),
    schemaVersion: version(datos.schemaVersion, true),
  };
}
export function validarAsociacionUpdate(
  body: unknown,
): AsociacionTipoCaracteristicaUpdateRequest {
  const datos = objeto(body);
  const schemaVersion = version(datos.schemaVersion, false);
  if (schemaVersion == null)
    throw ProblemDetailsException.validacion('schemaVersion es obligatorio.');
  return { obligatoria: obligatorio(datos.obligatoria), schemaVersion };
}
