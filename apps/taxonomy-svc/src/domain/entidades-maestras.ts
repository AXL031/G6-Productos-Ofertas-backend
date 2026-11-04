import {
  evaluarCheckBaja,
  type IdentidadBaja,
  type TipoMaestro,
} from './deactivation-check.js';

type TipoPendiente = Extract<
  TipoMaestro,
  'PRODUCT_TYPE' | 'CHARACTERISTIC_VALUE' | 'PRODUCT_TYPE_CHARACTERISTIC'
>;
export type EstadoMaestro = 'ACTIVO' | 'PENDING_DEACTIVATION' | 'INACTIVO';
export interface EstadoBaja {
  id: string;
  estado: EstadoMaestro;
  version: number;
  tipoProductoId?: string;
  caracteristicaId?: string;
}
export type DecisionBaja =
  | { estado: 'IGNORADA' }
  | { estado: 'RECHAZADA'; entidad: EstadoBaja }
  | { estado: 'COMPLETADA'; entidad: EstadoBaja };

/** Calcula una transición; el caso de uso debe persistirla con su evento. */
export abstract class ServicioMaestro {
  protected abstract readonly tipo: TipoPendiente;

  admitir(entidad: EstadoBaja, operacion: IdentidadBaja): EstadoBaja | null {
    if (
      entidad.estado !== 'ACTIVO' ||
      entidad.id !== operacion.entityId ||
      operacion.entityType !== this.tipo ||
      !operacion.operationId ||
      !operacion.correlationId ||
      !Number.isSafeInteger(entidad.version) ||
      entidad.version < 0 ||
      entidad.version !== operacion.version ||
      (this.tipo === 'PRODUCT_TYPE_CHARACTERISTIC' &&
        (!entidad.tipoProductoId ||
          !entidad.caracteristicaId ||
          entidad.tipoProductoId !== operacion.tipoProductoId ||
          entidad.caracteristicaId !== operacion.caracteristicaId))
    )
      return null;
    return { ...entidad, estado: 'PENDING_DEACTIVATION' };
  }

  evaluar(
    entidad: EstadoBaja,
    esperada: IdentidadBaja,
    respuesta: IdentidadBaja & { result: unknown },
  ): DecisionBaja {
    if (
      entidad.estado !== 'PENDING_DEACTIVATION' ||
      entidad.id !== esperada.entityId ||
      entidad.version !== esperada.version ||
      esperada.entityType !== this.tipo ||
      (this.tipo === 'PRODUCT_TYPE_CHARACTERISTIC' &&
        (entidad.tipoProductoId !== esperada.tipoProductoId ||
          entidad.caracteristicaId !== esperada.caracteristicaId))
    )
      return { estado: 'IGNORADA' };
    const decision = evaluarCheckBaja(esperada, respuesta);
    if (decision === 'IGNORAR') return { estado: 'IGNORADA' };
    if (decision === 'RECHAZAR_BAJA')
      return { estado: 'RECHAZADA', entidad: { ...entidad, estado: 'ACTIVO' } };
    if (entidad.version >= Number.MAX_SAFE_INTEGER)
      return { estado: 'IGNORADA' };
    return {
      estado: 'COMPLETADA',
      entidad: { ...entidad, estado: 'INACTIVO', version: entidad.version + 1 },
    };
  }
}

export class ProductTypeDomainService extends ServicioMaestro {
  protected readonly tipo = 'PRODUCT_TYPE' as const;
}
export class CharacteristicValueDomainService extends ServicioMaestro {
  protected readonly tipo = 'CHARACTERISTIC_VALUE' as const;
}
export class ProductTypeCharacteristicDomainService extends ServicioMaestro {
  protected readonly tipo = 'PRODUCT_TYPE_CHARACTERISTIC' as const;
}
