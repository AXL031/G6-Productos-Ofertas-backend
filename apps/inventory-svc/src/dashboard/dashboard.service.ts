import { Injectable, Inject } from '@nestjs/common';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  DashboardInventario,
  DashboardUbicacion,
} from '../types/inventory.dto.js';
import { STOCK_BALANCE_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';

type EstadoStock = 'DISPONIBLE' | 'STOCK_BAJO' | 'AGOTADO';

export interface DashboardFiltros {
  productoId?: string;
  categoriaId?: string;
  marcaId?: string;
  sku?: string;
  locationId?: string;
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stockBalanceRepository: IStockBalanceRepository,
  ) {}

  /**
   * Read model del dashboard (SPEC-016). Calcula indicadores por SKU y por
   * ubicación a partir de `stock_balance` y el umbral efectivo vigente.
   *
   * `productoId`/`categoriaId`/`marcaId` son atributos de catálogo que Inventario
   * no posee; no pueden aplicarse localmente y se rechazan como 400 en lugar de
   * devolver un resultado sin filtrar.
   */
  async obtenerDashboard(
    filtros: DashboardFiltros,
    correlationId?: string,
  ): Promise<DashboardInventario> {
    if (
      filtros.locationId !== undefined &&
      (typeof filtros.locationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          filtros.locationId,
        ))
    ) {
      throw ProblemDetailsException.validation(
        'locationId debe ser un UUID válido',
        correlationId,
      );
    }
    if (
      filtros.productoId !== undefined ||
      filtros.categoriaId !== undefined ||
      filtros.marcaId !== undefined
    ) {
      throw ProblemDetailsException.validation(
        'Inventario no puede filtrar por productoId, categoriaId ni marcaId: son atributos de catálogo fuera de su dominio',
        correlationId,
      );
    }

    const [rows, overrides] = await Promise.all([
      this.stockBalanceRepository.findByFilters({
        sku: filtros.sku,
        locationId: filtros.locationId,
      }),
      this.stockBalanceRepository.findThresholdOverrides(),
    ]);

    const defaultThreshold = loadInventoryConfig().defaultLowStockThreshold;
    let globalThreshold = defaultThreshold;
    const skuThresholds = new Map<string, number>();
    for (const override of overrides) {
      if (override.sku_id === null) {
        globalThreshold = override.umbral_efectivo;
      } else {
        skuThresholds.set(override.sku_id, override.umbral_efectivo);
      }
    }
    const thresholdFor = (sku: string): number =>
      skuThresholds.get(sku) ?? globalThreshold;

    const classify = (available: number, threshold: number): EstadoStock => {
      if (available <= 0) return 'AGOTADO';
      if (available <= threshold) return 'STOCK_BAJO';
      return 'DISPONIBLE';
    };

    // Agregación por SKU (universo de "SKU vendibles" monitoreados).
    const porSku = new Map<
      string,
      { onHand: number; reserved: number; available: number }
    >();
    // Agregación por ubicación.
    const porUbic = new Map<
      string,
      {
        onHand: number;
        reserved: number;
        available: number;
        disponibles: number;
        stockBajo: number;
        agotados: number;
      }
    >();

    for (const row of rows) {
      const skuAgg = porSku.get(row.sku_id) ?? {
        onHand: 0,
        reserved: 0,
        available: 0,
      };
      skuAgg.onHand += row.on_hand;
      skuAgg.reserved += row.reserved;
      skuAgg.available += row.available;
      porSku.set(row.sku_id, skuAgg);

      const ubic = porUbic.get(row.location_id) ?? {
        onHand: 0,
        reserved: 0,
        available: 0,
        disponibles: 0,
        stockBajo: 0,
        agotados: 0,
      };
      ubic.onHand += row.on_hand;
      ubic.reserved += row.reserved;
      ubic.available += row.available;
      const estado = classify(row.available, thresholdFor(row.sku_id));
      if (estado === 'AGOTADO') ubic.agotados += 1;
      else if (estado === 'STOCK_BAJO') ubic.stockBajo += 1;
      else ubic.disponibles += 1;
      porUbic.set(row.location_id, ubic);
    }

    let totalOnHand = 0;
    let totalReserved = 0;
    let totalAvailable = 0;
    let skusDisponibles = 0;
    let skusStockBajo = 0;
    let skusAgotados = 0;

    for (const [sku, agg] of porSku) {
      totalOnHand += agg.onHand;
      totalReserved += agg.reserved;
      totalAvailable += agg.available;
      const estado = classify(agg.available, thresholdFor(sku));
      if (estado === 'AGOTADO') skusAgotados += 1;
      else if (estado === 'STOCK_BAJO') skusStockBajo += 1;
      else skusDisponibles += 1;
    }

    const porUbicacion: DashboardUbicacion[] = [...porUbic.entries()]
      .map(([locationId, agg]) => ({
        location_id: locationId,
        on_hand: agg.onHand,
        reserved: agg.reserved,
        available: agg.available,
        skusDisponibles: agg.disponibles,
        skusStockBajo: agg.stockBajo,
        skusAgotados: agg.agotados,
      }))
      .sort((a, b) => a.location_id.localeCompare(b.location_id));

    return {
      generatedAt: new Date().toISOString(),
      totalSkus: porSku.size,
      totalOnHand,
      totalReserved,
      totalAvailable,
      skusDisponibles,
      skusStockBajo,
      skusAgotados,
      porUbicacion,
    };
  }
}
