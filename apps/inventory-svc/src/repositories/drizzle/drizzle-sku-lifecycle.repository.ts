import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import type { ISkuLifecycleRepository } from '../interfaces/sku-lifecycle.repository.interface.js';

@Injectable()
export class DrizzleSkuLifecycleRepository implements ISkuLifecycleRepository {
  constructor(private readonly database: DatabaseService) {}

  async findInactiveSkus(skus: string[]): Promise<Set<string>> {
    if (skus.length === 0) return new Set();
    const result = await this.database.query<{ sku_id: string }>(
      `SELECT sku_id
         FROM inventory.sku_lifecycle
        WHERE sku_id = ANY($1::text[]) AND active = false`,
      [skus],
    );
    return new Set(result.rows.map((row) => row.sku_id));
  }
}
