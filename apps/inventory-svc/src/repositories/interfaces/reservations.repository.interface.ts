import { IDatabaseClient } from '../../database/database.interface.js';

export interface ReservationEntity {
  id: string;
  reservation_id: string;
  status: 'ACTIVA' | 'CONSUMIDA' | 'LIBERADA' | 'EXPIRADA';
  expires_at: string;
  idempotency_key: string;
  intention: string;
  correlation_id?: string | null;
  order_id?: string | null;
  operation_id?: string | null;
  consumed_at?: string | null;
  released_at?: string | null;
  expired_at?: string | null;
  request_fingerprint?: string | null;
  accepted_payload?: any;
}

export interface ReservationLineEntity {
  id?: string;
  reservation_id: string;
  sku_id: string;
  location_id: string;
  quantity: number;
}

export interface IReservationsRepository {
  findById(
    id: string,
    client?: IDatabaseClient,
  ): Promise<ReservationEntity | null>;

  findByIdForUpdate(
    client: IDatabaseClient,
    id: string,
  ): Promise<ReservationEntity | null>;

  findByReservationId(
    reservationId: string,
    client?: IDatabaseClient,
  ): Promise<ReservationEntity | null>;

  findByReservationIdForUpdate(
    client: IDatabaseClient,
    reservationId: string,
  ): Promise<ReservationEntity | null>;

  create(
    client: IDatabaseClient,
    reservation: {
      reservation_id: string;
      status: 'ACTIVA' | 'CONSUMIDA' | 'LIBERADA' | 'EXPIRADA';
      expires_at: string;
      idempotency_key: string;
      intention: string;
      correlation_id?: string | null;
      order_id?: string | null;
      operation_id?: string | null;
      request_fingerprint?: string | null;
      accepted_payload?: string | null;
    },
  ): Promise<string>;

  createLines(
    client: IDatabaseClient,
    lines: Array<{
      reservation_id: string;
      sku_id: string;
      location_id: string;
      quantity: number;
    }>,
  ): Promise<void>;

  findLinesByReservationPk(
    client: IDatabaseClient,
    reservationPk: string,
  ): Promise<ReservationLineEntity[]>;

  updateStatus(
    client: IDatabaseClient,
    reservationPk: string,
    status: 'CONSUMIDA' | 'LIBERADA' | 'EXPIRADA',
  ): Promise<number>;
}
