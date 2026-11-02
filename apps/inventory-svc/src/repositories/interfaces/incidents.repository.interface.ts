import { IDatabaseClient } from '../../database/database.interface.js';

export interface IncidenciaEntity {
  id: string;
  incidencia_id: string;
  sku_id: string;
  location_id: string;
  external_incident_id?: string | null;
  act_ref?: string | null;
  estado: 'ABIERTA' | 'RESUELTA' | 'TRASLADO_PENDIENTE';
  tipo_resolucion?:
    | 'REHABILITADO'
    | 'MERMA'
    | 'FALTANTE_CONFIRMADO'
    | 'TRASLADO_ALMACEN_CENTRAL'
    | null;
  cantidad_bloqueada: number;
  idempotency_key: string;
  correlation_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  resolved_at?: string | null;
}

export interface CreateIncidenciaInput {
  incidencia_id: string;
  sku_id: string;
  location_id: string;
  external_incident_id?: string | null;
  cantidad_bloqueada: number;
  idempotency_key: string;
  correlation_id?: string | null;
}

export interface ResolveIncidenciaInput {
  id: string;
  estado: 'RESUELTA' | 'TRASLADO_PENDIENTE';
  tipo_resolucion:
    | 'REHABILITADO'
    | 'MERMA'
    | 'FALTANTE_CONFIRMADO'
    | 'TRASLADO_ALMACEN_CENTRAL';
  act_ref: string;
}

export interface IIncidentsRepository {
  findByIdempotencyKey(
    idempotencyKey: string,
    client?: IDatabaseClient,
  ): Promise<IncidenciaEntity | null>;

  findByIncidenciaIdForUpdate(
    client: IDatabaseClient,
    incidenciaId: string,
  ): Promise<IncidenciaEntity | null>;

  create(
    client: IDatabaseClient,
    input: CreateIncidenciaInput,
  ): Promise<IncidenciaEntity>;

  resolve(
    client: IDatabaseClient,
    input: ResolveIncidenciaInput,
  ): Promise<IncidenciaEntity>;
}
