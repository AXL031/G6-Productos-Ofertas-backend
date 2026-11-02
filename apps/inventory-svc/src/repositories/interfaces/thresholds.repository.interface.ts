import { IDatabaseClient } from '../../database/database.interface.js';

export interface SkuThresholdOverride {
  sku_id: string;
  umbral_efectivo: number;
}

export interface IThresholdsRepository {
  /**
   * Umbral global persistido (fila con sku_id IS NULL AND location_id IS NULL).
   * Devuelve null cuando no existe override global.
   */
  getGlobalThreshold(client?: IDatabaseClient): Promise<number | null>;

  /** Inserta o actualiza el umbral global (fila única con sku_id/location_id nulos). */
  setGlobalThreshold(client: IDatabaseClient, umbral: number): Promise<void>;

  /** Overrides por SKU (sku_id IS NOT NULL). */
  listSkuOverrides(client?: IDatabaseClient): Promise<SkuThresholdOverride[]>;

  /** Inserta o actualiza el override de un SKU. */
  upsertSkuOverride(
    client: IDatabaseClient,
    sku: string,
    umbral: number,
  ): Promise<void>;

  /** Elimina el override de un SKU. Devuelve filas afectadas. */
  deleteSkuOverride(client: IDatabaseClient, sku: string): Promise<number>;

  /** true si existe al menos un saldo registrado para el SKU (SKU conocido por Inventario). */
  existsStockForSku(sku: string, client?: IDatabaseClient): Promise<boolean>;
}
