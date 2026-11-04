import { IDatabaseClient } from '../../database/database.interface.js';

export interface TrasladoEntity {
  id: string;
  traslado_id: string;
  source_incident_id?: string | null;
  sku_id: string;
  source_location_id: string;
  target_location_id: string;
  quantity_shipped: number;
  quantity_received: number;
  missing_quantity?: number | null;
  estado:
    | 'EN_TRANSITO'
    | 'RECIBIDO_PARCIAL'
    | 'COMPLETADO'
    | 'COMPLETADO_CON_DISCREPANCIA';
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RecepcionTrasladoEntity {
  id: string;
  recepcion_id: string;
  cantidad_recibida: number;
  disposicion:
    'REINGRESAR_DISPONIBLE' | 'REINGRESAR_BLOQUEADO' | 'CONFIRMAR_MERMA';
  es_recepcion_final: boolean;
  sub_gestor: string;
  idempotency_key: string;
  received_at: string;
}

export interface CreateTrasladoInput {
  traslado_id: string;
  source_incident_id?: string | null;
  sku_id: string;
  source_location_id: string;
  target_location_id: string;
  quantity_shipped: number;
}

export interface CreateRecepcionTrasladoInput {
  recepcion_id: string;
  traslado_pk: string;
  cantidad_recibida: number;
  disposicion:
    'REINGRESAR_DISPONIBLE' | 'REINGRESAR_BLOQUEADO' | 'CONFIRMAR_MERMA';
  es_recepcion_final: boolean;
  sub_gestor: string;
  idempotency_key: string;
  received_at: string;
}

export interface UpdateTrasladoInput {
  id: string;
  quantity_received: number;
  missing_quantity: number;
  estado:
    | 'EN_TRANSITO'
    | 'RECIBIDO_PARCIAL'
    | 'COMPLETADO'
    | 'COMPLETADO_CON_DISCREPANCIA';
}

export interface ListTrasladosFilters {
  estado?: string;
  targetLocationId?: string;
  pagina: number;
  tamanio: number;
}

export interface ITrasladosRepository {
  findByIdForUpdate(
    client: IDatabaseClient,
    trasladoId: string,
  ): Promise<TrasladoEntity | null>;

  findByTrasladoId(
    trasladoId: string,
    client?: IDatabaseClient,
  ): Promise<TrasladoEntity | null>;

  findRecepcionByRecepcionId(
    recepcionId: string,
    client?: IDatabaseClient,
  ): Promise<RecepcionTrasladoEntity | null>;

  findRecepcionByIdempotencyKey(
    idempotencyKey: string,
    client?: IDatabaseClient,
  ): Promise<RecepcionTrasladoEntity | null>;

  list(
    filters: ListTrasladosFilters,
    client?: IDatabaseClient,
  ): Promise<{ items: TrasladoEntity[]; total: number }>;

  create(
    client: IDatabaseClient,
    input: CreateTrasladoInput,
  ): Promise<TrasladoEntity>;

  createRecepcion(
    client: IDatabaseClient,
    input: CreateRecepcionTrasladoInput,
  ): Promise<RecepcionTrasladoEntity>;

  update(
    client: IDatabaseClient,
    input: UpdateTrasladoInput,
  ): Promise<TrasladoEntity>;
}
