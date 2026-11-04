import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from './database.js';
import { CatalogPersistenceError } from './database-errors.js';

export class BarcodeAdministrationError extends Error {
  constructor(
    readonly code:
      | 'SKU_NOT_SELLABLE'
      | 'BARCODE_ALREADY_REGISTERED'
      | 'BARCODE_NOT_REGISTERED',
  ) {
    super(code);
  }
}

@Injectable()
export class BarcodeRepository {
  constructor(private readonly database: Database) {}

  async resolve(code: string): Promise<string | null> {
    return this.database.read(async (db) => {
      const result =
        await db.execute(sql`SELECT si.sku FROM catalog.sku_barcodes b
        JOIN catalog.sku_identity si ON si.id = b.sku_identity_id
        LEFT JOIN catalog.variants v ON v.id = si.variant_id
        JOIN catalog.products p ON p.id = COALESCE(si.product_id, v.product_id)
        WHERE b.codigo_barras = ${code} AND b.retired_at IS NULL AND p.estado = 'ACTIVO'
        AND ((si.product_id IS NOT NULL AND NOT p.tiene_variantes)
          OR (si.variant_id IS NOT NULL AND p.tiene_variantes AND v.estado = 'ACTIVA'))`);
      if (result.rows.length > 1) throw new Error();
      const sku = result.rows[0]?.sku;
      if (sku !== undefined && typeof sku !== 'string') throw new Error();
      return (sku as string | undefined) ?? null;
    });
  }

  async register(code: string, sku: string, actor: string) {
    try {
      return await this.database.transaction(async (tx) => {
        const target =
          await tx.execute(sql`SELECT si.id FROM catalog.sku_identity si
          LEFT JOIN catalog.variants v ON v.id = si.variant_id
          JOIN catalog.products p ON p.id = COALESCE(si.product_id, v.product_id)
          WHERE si.sku = ${sku} AND ((si.product_id IS NOT NULL AND NOT p.tiene_variantes)
            OR (si.variant_id IS NOT NULL AND p.tiene_variantes))`);
        if (!target.rows.length)
          throw new BarcodeAdministrationError('SKU_NOT_SELLABLE');
        const result =
          await tx.execute(sql`INSERT INTO catalog.sku_barcodes(codigo_barras, sku_identity_id, created_by)
          VALUES (${code}, ${target.rows[0].id}::uuid, ${actor})
          RETURNING id, codigo_barras, created_at, created_by, retired_at, retired_by`);
        return result.rows[0];
      });
    } catch (error) {
      if (
        error instanceof CatalogPersistenceError &&
        error.failure === 'unique'
      )
        throw new BarcodeAdministrationError('BARCODE_ALREADY_REGISTERED');
      throw error;
    }
  }

  async list(sku: string) {
    return this.database.read(
      async (db) =>
        (
          await db.execute(sql`SELECT b.id, b.codigo_barras,
      b.created_at, b.created_by, b.retired_at, b.retired_by FROM catalog.sku_barcodes b
      JOIN catalog.sku_identity si ON si.id = b.sku_identity_id WHERE si.sku = ${sku}
      ORDER BY b.created_at, b.id`)
        ).rows,
    );
  }

  async retire(code: string, actor: string) {
    return this.database.transaction(async (tx) => {
      const rows =
        await tx.execute(sql`SELECT id, retired_at FROM catalog.sku_barcodes
        WHERE codigo_barras = ${code} FOR UPDATE`);
      if (!rows.rows.length)
        throw new BarcodeAdministrationError('BARCODE_NOT_REGISTERED');
      const result = await tx.execute(sql`UPDATE catalog.sku_barcodes SET
        retired_at = COALESCE(retired_at, clock_timestamp()), retired_by = COALESCE(retired_by, ${actor})
        WHERE id = ${rows.rows[0].id}::uuid RETURNING id, codigo_barras, created_at, created_by, retired_at, retired_by`);
      return result.rows[0];
    });
  }
}
