import { Injectable } from '@nestjs/common';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { DatabaseService } from '../database/database.service.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  DashboardInventario,
  DashboardUbicacion,
} from '../types/inventory.dto.js';

export interface DashboardFiltros {
  productoId?: string;
  categoriaId?: string;
  marcaId?: string;
  sku?: string;
  locationId?: string;
}

/** SPEC-016 indicators kept internal until OpenAPI approves an expanded DTO. */
export interface DashboardMetricasInternas {
  unidadesFisicas: number;
  unidadesReservadas: number;
  unidadesBloqueadas: number;
  unidadesDisponibles: number;
  skuPorEstado: {
    DISPONIBLE: number;
    STOCK_BAJO: number;
    AGOTADO: number;
  };
  trasladosPendientes: number;
  trasladosConDiscrepancia: number;
}

interface DashboardAggregateRow {
  group_kind: 'TOTAL' | 'LOCATION';
  location_id: string | null;
  total_skus: string | number;
  total_on_hand: string | number;
  total_reserved: string | number;
  total_blocked: string | number;
  total_available: string | number;
  skus_disponibles: string | number;
  skus_stock_bajo: string | number;
  skus_agotados: string | number;
}

const DASHBOARD_AGGREGATE_SQL = `
  WITH filtered_balance AS MATERIALIZED (
    SELECT
      balance.sku_id,
      balance.location_id,
      balance.on_hand,
      balance.reserved,
      balance.blocked,
      balance.available,
      COALESCE(sku_threshold.umbral_efectivo, global_threshold.umbral_efectivo, $3)::integer AS threshold
    FROM inventory.stock_balance AS balance
    LEFT JOIN inventory.stock_threshold_override AS sku_threshold
      ON sku_threshold.sku_id = balance.sku_id
     AND sku_threshold.location_id IS NULL
    LEFT JOIN inventory.stock_threshold_override AS global_threshold
      ON global_threshold.sku_id IS NULL
     AND global_threshold.location_id IS NULL
    WHERE ($1::text IS NULL OR balance.sku_id = $1)
      AND ($2::uuid IS NULL OR balance.location_id = $2)
  ),
  by_sku AS (
    SELECT
      sku_id,
      SUM(on_hand)::bigint AS on_hand,
      SUM(reserved)::bigint AS reserved,
      SUM(blocked)::bigint AS blocked,
      SUM(available)::bigint AS available,
      MAX(threshold) AS threshold
    FROM filtered_balance
    GROUP BY sku_id
  ),
  by_location AS (
    SELECT
      location_id,
      SUM(on_hand)::bigint AS on_hand,
      SUM(reserved)::bigint AS reserved,
      SUM(blocked)::bigint AS blocked,
      SUM(available)::bigint AS available,
      COUNT(*) FILTER (WHERE available <= 0)::bigint AS agotados,
      COUNT(*) FILTER (WHERE available > 0 AND available <= threshold)::bigint AS stock_bajo,
      COUNT(*) FILTER (WHERE available > threshold)::bigint AS disponibles
    FROM filtered_balance
    GROUP BY location_id
  ),
  total AS (
    SELECT
      COUNT(*)::bigint AS total_skus,
      COALESCE(SUM(on_hand), 0)::bigint AS total_on_hand,
      COALESCE(SUM(reserved), 0)::bigint AS total_reserved,
      COALESCE(SUM(blocked), 0)::bigint AS total_blocked,
      COALESCE(SUM(available), 0)::bigint AS total_available,
      COUNT(*) FILTER (WHERE available <= 0)::bigint AS agotados,
      COUNT(*) FILTER (WHERE available > 0 AND available <= threshold)::bigint AS stock_bajo,
      COUNT(*) FILTER (WHERE available > threshold)::bigint AS disponibles
    FROM by_sku
  )
  SELECT
    'TOTAL'::text AS group_kind,
    NULL::uuid AS location_id,
    total_skus,
    total_on_hand,
    total_reserved,
    total_blocked,
    total_available,
    disponibles AS skus_disponibles,
    stock_bajo AS skus_stock_bajo,
    agotados AS skus_agotados
  FROM total
  UNION ALL
  SELECT
    'LOCATION'::text AS group_kind,
    location_id,
    0::bigint AS total_skus,
    on_hand AS total_on_hand,
    reserved AS total_reserved,
    blocked AS total_blocked,
    available AS total_available,
    disponibles AS skus_disponibles,
    stock_bajo AS skus_stock_bajo,
    agotados AS skus_agotados
  FROM by_location
  ORDER BY group_kind, location_id
`;

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  /** Additional SPEC-016 indicators remain internal; the public DTO is unchanged. */
  async obtenerMetricasInternas(
    filtros: DashboardFiltros = {},
  ): Promise<DashboardMetricasInternas> {
    this.validarFiltros(filtros);
    const [rows, transfers] = await Promise.all([
      this.getAggregates(filtros),
      this.database.query<{
        pendientes: number;
        discrepancias: number;
      }>(
        `SELECT
           count(*) FILTER (WHERE estado IN ('EN_TRANSITO', 'RECIBIDO_PARCIAL'))::int AS pendientes,
           count(*) FILTER (WHERE estado = 'COMPLETADO_CON_DISCREPANCIA')::int AS discrepancias
         FROM inventory.traslados
         WHERE ($1::text IS NULL OR sku_id = $1)
           AND ($2::uuid IS NULL OR source_location_id = $2 OR target_location_id = $2)`,
        [filtros.sku ?? null, filtros.locationId ?? null],
      ),
    ]);
    const total = rows.find((row) => row.group_kind === 'TOTAL');
    return {
      unidadesFisicas: numberValue(total?.total_on_hand),
      unidadesReservadas: numberValue(total?.total_reserved),
      unidadesBloqueadas: numberValue(total?.total_blocked),
      unidadesDisponibles: numberValue(total?.total_available),
      skuPorEstado: {
        DISPONIBLE: numberValue(total?.skus_disponibles),
        STOCK_BAJO: numberValue(total?.skus_stock_bajo),
        AGOTADO: numberValue(total?.skus_agotados),
      },
      trasladosPendientes: Number(transfers.rows[0]?.pendientes ?? 0),
      trasladosConDiscrepancia: Number(transfers.rows[0]?.discrepancias ?? 0),
    };
  }

  /**
   * Read model del dashboard (SPEC-016). SQL calcula los agregados antes de
   * cruzar la red: el resultado queda acotado a una fila total y una por
   * ubicación, en vez de transferir cada saldo SKU/ubicación al proceso Node.
   *
   * `productoId`/`categoriaId`/`marcaId` son atributos de catálogo que Inventario
   * no posee; no pueden aplicarse localmente y se rechazan como 400 en lugar de
   * devolver un resultado sin filtrar.
   */
  async obtenerDashboard(
    filtros: DashboardFiltros,
    correlationId?: string,
  ): Promise<DashboardInventario> {
    this.validarFiltros(filtros, correlationId);
    const rows = await this.getAggregates(filtros);
    const total = rows.find((row) => row.group_kind === 'TOTAL');
    const porUbicacion: DashboardUbicacion[] = rows
      .filter((row) => row.group_kind === 'LOCATION' && row.location_id)
      .map((row) => ({
        location_id: row.location_id!,
        on_hand: numberValue(row.total_on_hand),
        reserved: numberValue(row.total_reserved),
        available: numberValue(row.total_available),
        skusDisponibles: numberValue(row.skus_disponibles),
        skusStockBajo: numberValue(row.skus_stock_bajo),
        skusAgotados: numberValue(row.skus_agotados),
      }));

    return {
      generatedAt: new Date().toISOString(),
      totalSkus: numberValue(total?.total_skus),
      totalOnHand: numberValue(total?.total_on_hand),
      totalReserved: numberValue(total?.total_reserved),
      totalAvailable: numberValue(total?.total_available),
      skusDisponibles: numberValue(total?.skus_disponibles),
      skusStockBajo: numberValue(total?.skus_stock_bajo),
      skusAgotados: numberValue(total?.skus_agotados),
      porUbicacion,
    };
  }

  private async getAggregates(
    filtros: DashboardFiltros,
  ): Promise<DashboardAggregateRow[]> {
    const result = await this.database.query<DashboardAggregateRow>(
      DASHBOARD_AGGREGATE_SQL,
      [
        filtros.sku || null,
        filtros.locationId ?? null,
        loadInventoryConfig().defaultLowStockThreshold,
      ],
    );
    return result.rows;
  }

  private validarFiltros(
    filtros: DashboardFiltros,
    correlationId?: string,
  ): void {
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
  }
}

function numberValue(value: string | number | undefined): number {
  return Number(value ?? 0);
}
