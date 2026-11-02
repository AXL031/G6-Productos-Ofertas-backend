/** Validación interna de la frontera DEC-G6-INT-05; no completa una baja. */
export type TipoMaestro =
  | 'CATEGORY'
  | 'BRAND'
  | 'PRODUCT_TYPE'
  | 'CHARACTERISTIC_VALUE'
  | 'PRODUCT_TYPE_CHARACTERISTIC';

export interface IdentidadBaja {
  operationId: string;
  correlationId: string;
  entityType: TipoMaestro;
  entityId: string;
  version: number;
  tipoProductoId?: string;
  caracteristicaId?: string;
}

export type ResultadoEvaluacion = 'IGNORAR' | 'EVALUAR_BAJA' | 'RECHAZAR_BAJA';

const TIPOS_MAESTROS: readonly string[] = [
  'CATEGORY',
  'BRAND',
  'PRODUCT_TYPE',
  'CHARACTERISTIC_VALUE',
  'PRODUCT_TYPE_CHARACTERISTIC',
];

export function evaluarCheckBaja(
  esperada: IdentidadBaja,
  respuesta: IdentidadBaja & { result: unknown },
): ResultadoEvaluacion {
  if (
    !esperada.operationId ||
    !esperada.correlationId ||
    !esperada.entityId ||
    !TIPOS_MAESTROS.includes(esperada.entityType) ||
    !Number.isSafeInteger(esperada.version) ||
    esperada.version < 0 ||
    respuesta.operationId !== esperada.operationId ||
    respuesta.correlationId !== esperada.correlationId ||
    respuesta.entityType !== esperada.entityType ||
    respuesta.entityId !== esperada.entityId ||
    respuesta.version !== esperada.version ||
    (esperada.entityType === 'PRODUCT_TYPE_CHARACTERISTIC' &&
      (!esperada.tipoProductoId ||
        !esperada.caracteristicaId ||
        respuesta.tipoProductoId !== esperada.tipoProductoId ||
        respuesta.caracteristicaId !== esperada.caracteristicaId))
  ) {
    return 'IGNORAR';
  }
  if (respuesta.result === 'CLEAR') return 'EVALUAR_BAJA';
  if (respuesta.result === 'IN_USE') return 'RECHAZAR_BAJA';
  return 'IGNORAR';
}
