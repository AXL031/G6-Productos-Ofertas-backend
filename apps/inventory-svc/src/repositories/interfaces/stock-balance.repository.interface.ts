import { IDatabaseClient } from '../../database/database.interface.js';

export interface StockBalanceEntity {
  sku_id: string;
  location_id: string;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  stock_version: number;
}

export interface IStockBalanceRepository {
  /** Inicialización idempotente; nunca sustituye un saldo existente. */
  initializeZero(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
  ): Promise<boolean>;
  findBySkuAndLocationForUpdate(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
  ): Promise<StockBalanceEntity | null>;

  updateStock(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
    values: {
      on_hand?: number;
      reserved?: number;
      blocked?: number;
      stock_version: number;
    },
  ): Promise<number>;

  /**
   * Acredita unidades al destino de un traslado creando el saldo si el SKU aún
   * no existía en esa ubicación (la recepción puede preceder a la primera
   * existencia física). Devuelve el saldo resultante.
   */
  upsertOnHandDelta(
    client: IDatabaseClient,
    sku: string,
    locationId: string,
    delta: { on_hand: number; blocked: number },
  ): Promise<StockBalanceEntity>;

  findBySkus(
    skus: string[],
    locationId?: string,
    client?: IDatabaseClient,
  ): Promise<StockBalanceEntity[]>;

  findByFilters(
    filters: { sku?: string; locationId?: string },
    client?: IDatabaseClient,
  ): Promise<StockBalanceEntity[]>;

  findThresholdOverrides(
    client?: IDatabaseClient,
  ): Promise<Array<{ sku_id: string | null; umbral_efectivo: number }>>;
}
