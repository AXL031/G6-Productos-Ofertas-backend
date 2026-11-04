import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import {
  IThresholdsRepository,
  SkuThresholdOverride,
} from '../interfaces/thresholds.repository.interface.js';

@Injectable()
export class DrizzleThresholdsRepository implements IThresholdsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getGlobalThreshold(client?: IDatabaseClient): Promise<number | null> {
    const sql = `
      SELECT umbral_efectivo
      FROM inventory.stock_threshold_override
      WHERE sku_id IS NULL AND location_id IS NULL
      LIMIT 1
    `;
    const res = client
      ? await client.query(sql)
      : await this.databaseService.query(sql);
    if (res.rows.length === 0) return null;
    return Number((res.rows[0] as any).umbral_efectivo);
  }

  async setGlobalThreshold(
    client: IDatabaseClient,
    umbral: number,
  ): Promise<void> {
    const updated = await client.query(
      `UPDATE inventory.stock_threshold_override
         SET umbral_efectivo = $1, updated_at = now()
       WHERE sku_id IS NULL AND location_id IS NULL`,
      [umbral],
    );
    if (updated.rowCount > 0) return;
    await client.query(
      `INSERT INTO inventory.stock_threshold_override (sku_id, location_id, umbral_efectivo)
       VALUES (NULL, NULL, $1)`,
      [umbral],
    );
  }

  async listSkuOverrides(
    client?: IDatabaseClient,
  ): Promise<SkuThresholdOverride[]> {
    const sql = `
      SELECT sku_id, umbral_efectivo
      FROM inventory.stock_threshold_override
      WHERE sku_id IS NOT NULL
      ORDER BY sku_id ASC
    `;
    const res = client
      ? await client.query(sql)
      : await this.databaseService.query(sql);
    return res.rows.map((row: any) => ({
      sku_id: row.sku_id,
      umbral_efectivo: Number(row.umbral_efectivo),
    }));
  }

  async upsertSkuOverride(
    client: IDatabaseClient,
    sku: string,
    umbral: number,
  ): Promise<void> {
    const updated = await client.query(
      `UPDATE inventory.stock_threshold_override
         SET umbral_efectivo = $1, updated_at = now()
       WHERE sku_id = $2 AND location_id IS NULL`,
      [umbral, sku],
    );
    if (updated.rowCount > 0) return;
    await client.query(
      `INSERT INTO inventory.stock_threshold_override (sku_id, location_id, umbral_efectivo)
       VALUES ($1, NULL, $2)`,
      [sku, umbral],
    );
  }

  async deleteSkuOverride(
    client: IDatabaseClient,
    sku: string,
  ): Promise<number> {
    const res = await client.query(
      `DELETE FROM inventory.stock_threshold_override
       WHERE sku_id = $1 AND location_id IS NULL`,
      [sku],
    );
    return res.rowCount;
  }

  async existsStockForSku(
    sku: string,
    client?: IDatabaseClient,
  ): Promise<boolean> {
    const sql = `SELECT sku_id FROM inventory.stock_balance WHERE sku_id = $1 LIMIT 1`;
    const res = client
      ? await client.query(sql, [sku])
      : await this.databaseService.query(sql, [sku]);
    return res.rows.length > 0;
  }
}
