import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import * as schema from '../../drizzle/schema.js';
import {
  IKardexRepository,
  KardexMovementEntity,
} from '../interfaces/kardex.repository.interface.js';

@Injectable()
export class DrizzleKardexRepository implements IKardexRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createMovement(
    client: IDatabaseClient,
    movement: KardexMovementEntity,
  ): Promise<void> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      await db.insert(schema.kardex).values({
        sku_id: movement.sku_id,
        location_id: movement.location_id,
        operation_type: movement.operation_type as any,
        operation_id: movement.operation_id ?? undefined,
        reservation_id: movement.reservation_id ?? undefined,
        quantity: movement.quantity,
        on_hand_before: movement.on_hand_before,
        on_hand_after: movement.on_hand_after,
        reserved_before: movement.reserved_before,
        reserved_after: movement.reserved_after,
        blocked_before: movement.blocked_before,
        blocked_after: movement.blocked_after,
        stock_version: Number(movement.stock_version),
        correlation_id: movement.correlation_id ?? undefined,
      });
      return;
    }

    const sql = `
      INSERT INTO inventory.kardex (
        sku_id, location_id, operation_type, operation_id, reservation_id,
        quantity, on_hand_before, on_hand_after,
        reserved_before, reserved_after, blocked_before, blocked_after,
        stock_version, correlation_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14
      )
    `;
    await client.query(sql, [
      movement.sku_id,
      movement.location_id,
      movement.operation_type,
      movement.operation_id ?? null,
      movement.reservation_id ?? null,
      movement.quantity,
      movement.on_hand_before,
      movement.on_hand_after,
      movement.reserved_before,
      movement.reserved_after,
      movement.blocked_before,
      movement.blocked_after,
      movement.stock_version,
      movement.correlation_id ?? null,
    ]);
  }
}
