import { IDatabaseClient } from '../../database/database.interface.js';

export interface OperationEntity {
  id: string;
  operation_type: string;
  idempotency_key: string;
  intention: string;
  status: string;
  sku_id?: string | null;
  location_id?: string | null;
  quantity_requested?: number | null;
  quantity_applied?: number | null;
  result_code?: string | null;
  correlation_id?: string | null;
  order_id?: string | null;
  reservation_id?: string | null;
  stock_version?: number | null;
  accepted_at?: string | null;
  applied_at?: string | null;
  operation_id?: string | null;
  client_id?: string | null;
  request_fingerprint?: string | null;
  request_payload?: any;
  result_payload?: any;
}

export interface IOperationsRepository {
  lockIdempotencyKey(
    client: IDatabaseClient,
    idempotencyKey: string,
  ): Promise<void>;

  findByOperationIdOrIdempotencyKey(
    operationId: string,
    idempotencyKey: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null>;

  findByOperationId(
    operationId: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null>;

  /**
   * Recupera la operación INCIDENCIA_BLOQUEO cuyo resultado referencia la
   * incidencia indicada. Necesario porque `inventory.incidencias` no persiste el
   * tipo físico reportado y la respuesta de resolución debe informarlo.
   */
  findIncidenciaBloqueoByIncidenciaId(
    incidenciaId: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null>;

  create(
    client: IDatabaseClient,
    op: {
      operation_type: string;
      idempotency_key: string;
      intention: string;
      status: string;
      order_id?: string | null;
      reservation_id?: string | null;
      operation_id?: string | null;
      request_fingerprint?: string | null;
      request_payload?: string | null;
      result_payload?: string | null;
      correlation_id?: string | null;
      result_code?: string | null;
      client_id?: string | null;
    },
  ): Promise<void>;
}
