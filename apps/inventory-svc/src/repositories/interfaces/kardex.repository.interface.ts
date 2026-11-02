import { IDatabaseClient } from '../../database/database.interface.js';

export interface NewKardexMovement {
  sku_id: string;
  location_id: string;
  operation_type: string;
  operation_id?: string | null;
  reservation_id?: string | null;
  quantity: number;
  on_hand_before: number;
  on_hand_after: number;
  reserved_before: number;
  reserved_after: number;
  blocked_before: number;
  blocked_after: number;
  stock_version: number;
  correlation_id?: string | null;
}

export interface IKardexRepository {
  createMovement(
    client: IDatabaseClient,
    movement: NewKardexMovement,
  ): Promise<void>;
}

export type KardexMovementEntity = NewKardexMovement;
