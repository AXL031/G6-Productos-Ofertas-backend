import { Injectable } from '@nestjs/common';
import { eq, and, inArray, asc } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import * as schema from '../../drizzle/schema.js';
import {
  IStockBalanceRepository,
  StockBalanceEntity,
} from '../interfaces/stock-balance.repository.interface.js';

@Injectable()
export class DrizzleStockBalanceRepository implements IStockBalanceRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async initializeZero(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand, reserved, blocked, stock_version)
       VALUES ($1, $2, 0, 0, 0, 0)
       ON CONFLICT (sku_id, location_id) DO NOTHING
       RETURNING sku_id`,
      [sku, locationId],
    );
    return result.rowCount === 1;
  }

  async findBySkuAndLocationForUpdate(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
  ): Promise<StockBalanceEntity | null> {
    // Conserva SQL explícito para bloqueos críticos (SELECT ... FOR UPDATE)
    const sql = `
      SELECT sku_id, location_id, on_hand, reserved, blocked, available, stock_version
      FROM inventory.stock_balance
      WHERE sku_id = $1 AND location_id = $2
      FOR UPDATE
    `;
    const res = await client.query(sql, [sku, locationId]);
    if (res.rows.length === 0) {
      return null;
    }
    const row = res.rows[0];
    return {
      sku_id: row.sku_id,
      location_id: row.location_id,
      on_hand: Number(row.on_hand),
      reserved: Number(row.reserved),
      blocked: Number(row.blocked),
      available: Number(row.available),
      stock_version: Number(row.stock_version),
    };
  }

  async updateStock(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
    values: {
      on_hand?: number;
      reserved?: number;
      blocked?: number;
      stock_version: number;
    },
  ): Promise<number> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const setObj: Record<string, any> = {
        stock_version: values.stock_version,
        updated_at: new Date(),
      };
      if (values.on_hand !== undefined) setObj.on_hand = values.on_hand;
      if (values.reserved !== undefined) setObj.reserved = values.reserved;
      if (values.blocked !== undefined) setObj.blocked = values.blocked;

      // Columna 'available' es GENERATED ALWAYS AS en la base física, NO se incluye en set
      const updated = await db
        .update(schema.stockBalance)
        .set(setObj)
        .where(
          and(
            eq(schema.stockBalance.sku_id, sku),
            eq(schema.stockBalance.location_id, locationId),
          ),
        )
        .returning({ sku_id: schema.stockBalance.sku_id });
      return updated.length;
    }

    if (values.on_hand !== undefined && values.reserved !== undefined) {
      const sql = `
        UPDATE inventory.stock_balance
        SET on_hand = $1, reserved = $2, stock_version = $3
        WHERE sku_id = $4 AND location_id = $5
      `;
      const res = await client.query(sql, [
        values.on_hand,
        values.reserved,
        values.stock_version,
        sku,
        locationId,
      ]);
      return res.rowCount;
    }

    if (values.reserved !== undefined) {
      const sql = `
        UPDATE inventory.stock_balance
        SET reserved = $1, stock_version = $2
        WHERE sku_id = $3 AND location_id = $4
      `;
      const res = await client.query(sql, [
        values.reserved,
        values.stock_version,
        sku,
        locationId,
      ]);
      return res.rowCount;
    }

    const setClauses: string[] = ['stock_version = $3'];
    const params: any[] = [sku, locationId, values.stock_version];
    let paramIndex = 4;

    if (values.on_hand !== undefined) {
      setClauses.push(`on_hand = $${paramIndex}`);
      params.push(values.on_hand);
      paramIndex++;
    }
    if (values.blocked !== undefined) {
      setClauses.push(`blocked = $${paramIndex}`);
      params.push(values.blocked);
      paramIndex++;
    }

    const sql = `
      UPDATE inventory.stock_balance
      SET ${setClauses.join(', ')}
      WHERE sku_id = $1 AND location_id = $2
    `;

    const res = await client.query(sql, params);
    return res.rowCount;
  }

  async upsertOnHandDelta(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
    delta: { on_hand: number; blocked: number },
  ): Promise<StockBalanceEntity> {
    const sql = `
      INSERT INTO inventory.stock_balance (
        sku_id, location_id, on_hand, reserved, blocked, stock_version
      ) VALUES ($1, $2, $3, 0, $4, 1)
      ON CONFLICT (sku_id, location_id) DO UPDATE
        SET on_hand = inventory.stock_balance.on_hand + EXCLUDED.on_hand,
            blocked = inventory.stock_balance.blocked + EXCLUDED.blocked,
            stock_version = inventory.stock_balance.stock_version + 1
      RETURNING sku_id, location_id, on_hand, reserved, blocked, available, stock_version
    `;
    const res = await client.query(sql, [
      sku,
      locationId,
      delta.on_hand,
      delta.blocked,
    ]);
    const row = res.rows[0];
    return {
      sku_id: row.sku_id,
      location_id: row.location_id,
      on_hand: Number(row.on_hand),
      reserved: Number(row.reserved),
      blocked: Number(row.blocked),
      available: Number(row.available),
      stock_version: Number(row.stock_version),
    };
  }

  async findBySkus(
    skus: string[],
    locationId?: string,
    client?: IDatabaseClient,
  ): Promise<StockBalanceEntity[]> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const conditions = [inArray(schema.stockBalance.sku_id, skus)];
      if (locationId) {
        conditions.push(eq(schema.stockBalance.location_id, locationId));
      }

      const rows = await db
        .select()
        .from(schema.stockBalance)
        .where(and(...conditions))
        .orderBy(
          asc(schema.stockBalance.sku_id),
          asc(schema.stockBalance.location_id),
        );

      return rows.map((row) => ({
        sku_id: row.sku_id,
        location_id: row.location_id,
        on_hand: Number(row.on_hand),
        reserved: Number(row.reserved),
        blocked: Number(row.blocked),
        available: Number(
          row.available ?? row.on_hand - row.reserved - row.blocked,
        ),
        stock_version: Number(row.stock_version),
      }));
    }

    let sql = `
      SELECT sku_id, location_id, on_hand, reserved, blocked, available, stock_version
      FROM inventory.stock_balance
      WHERE sku_id = ANY($1)
    `;
    const params: any[] = [skus];

    if (locationId) {
      sql += ` AND location_id = $2`;
      params.push(locationId);
    }
    sql += ` ORDER BY sku_id ASC, location_id ASC`;

    const res = client
      ? await client.query(sql, params)
      : await this.databaseService.query(sql, params);

    return res.rows.map((row: any) => ({
      sku_id: row.sku_id,
      location_id: row.location_id,
      on_hand: Number(row.on_hand),
      reserved: Number(row.reserved),
      blocked: Number(row.blocked),
      available: Number(row.available),
      stock_version: Number(row.stock_version),
    }));
  }

  async findByFilters(
    filters: { sku?: string; locationId?: string },
    client?: IDatabaseClient,
  ): Promise<StockBalanceEntity[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters.sku) {
      params.push(filters.sku);
      conditions.push(`sku_id = $${params.length}`);
    }
    if (filters.locationId) {
      params.push(filters.locationId);
      conditions.push(`location_id = $${params.length}`);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT sku_id, location_id, on_hand, reserved, blocked, available, stock_version
      FROM inventory.stock_balance
      ${where}
      ORDER BY sku_id ASC, location_id ASC
    `;
    const res = client
      ? await client.query(sql, params)
      : await this.databaseService.query(sql, params);

    return res.rows.map((row: any) => ({
      sku_id: row.sku_id,
      location_id: row.location_id,
      on_hand: Number(row.on_hand),
      reserved: Number(row.reserved),
      blocked: Number(row.blocked),
      available: Number(
        row.available ?? row.on_hand - row.reserved - row.blocked,
      ),
      stock_version: Number(row.stock_version),
    }));
  }

  async findThresholdOverrides(
    client?: IDatabaseClient,
  ): Promise<Array<{ sku_id: string | null; umbral_efectivo: number }>> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select({
          sku_id: schema.stockThresholdOverride.sku_id,
          umbral_efectivo: schema.stockThresholdOverride.umbral_efectivo,
        })
        .from(schema.stockThresholdOverride);

      return rows.map((r) => ({
        sku_id: r.sku_id ?? null,
        umbral_efectivo: Number(r.umbral_efectivo),
      }));
    }

    const sql = `SELECT sku_id, umbral_efectivo FROM inventory.stock_threshold_override`;
    const res = client
      ? await client.query(sql)
      : await this.databaseService.query(sql);

    return res.rows.map((r: any) => ({
      sku_id: r.sku_id ?? null,
      umbral_efectivo: Number(r.umbral_efectivo),
    }));
  }
}
