import { Injectable } from '@nestjs/common';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { DatabaseService } from '../database/database.service.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  DashboardInventario,
  DashboardUbicacion,
} from '../types/inventory.dto.js';

type EstadoStock = 'DISPONIBLE' | 'STOCK_BAJO' | 'AGOTADO';

interface SaldoFisicoRow {
  sku: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  locationType: string;
  locationActive: boolean;
  skuActivo: boolean | null;
  onHand: number;
  reserved: number;
  blocked: number;
  available: number;
  stockVersion: string;
  updatedAt: Date;
  umbralEfectivo: number;
  estado: EstadoStock;
}

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
  WITH sku_threshold AS MATERIALIZED (
    SELECT DISTINCT ON (sku_id)
      sku_id,
      umbral_efectivo
    FROM inventory.stock_threshold_override
    WHERE sku_id IS NOT NULL AND location_id IS NULL
    ORDER BY sku_id, updated_at DESC, created_at DESC, id DESC
  ),
  filtered_balance AS MATERIALIZED (
    SELECT
      balance.sku_id,
      balance.location_id,
      balance.on_hand,
      balance.reserved,
      balance.blocked,
      balance.available,
      COALESCE(sku_threshold.umbral_efectivo, global_threshold.umbral_efectivo, $3)::integer AS threshold
    FROM inventory.stock_balance AS balance
    LEFT JOIN sku_threshold
      ON sku_threshold.sku_id = balance.sku_id
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

  async listarSaldosFisicos(
    query: Record<string, unknown>,
    correlationId?: string,
  ) {
    const invalid = () =>
      ProblemDetailsException.validation(
        'Usar sku, locationId, estado, pagina y tamanio válidos',
        correlationId,
      );
    if (
      Object.keys(query).some(
        (key) =>
          !['sku', 'locationId', 'estado', 'pagina', 'tamanio'].includes(key),
      )
    )
      throw invalid();
    const { sku, locationId, estado } = query;
    if (
      estado !== undefined &&
      estado !== 'DISPONIBLE' &&
      estado !== 'STOCK_BAJO' &&
      estado !== 'AGOTADO'
    )
      throw invalid();
    if (
      (sku !== undefined &&
        (typeof sku !== 'string' || !sku.trim() || sku.includes('\0'))) ||
      (locationId !== undefined &&
        (typeof locationId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            locationId,
          )))
    )
      throw invalid();
    const positiveInt = (value: unknown, fallback: number, max: number) => {
      if (value === undefined) return fallback;
      if (
        typeof value !== 'string' ||
        !/^[1-9]\d*$/.test(value) ||
        Number(value) > max
      )
        throw invalid();
      return Number(value);
    };
    const tamanio = positiveInt(query.tamanio, 20, 100);
    const pagina = positiveInt(
      query.pagina,
      1,
      Math.floor(Number.MAX_SAFE_INTEGER / tamanio),
    );
    const params = [
      sku ?? null,
      locationId ?? null,
      loadInventoryConfig().defaultLowStockThreshold,
      estado ?? null,
    ];
    const unavailable = () =>
      new ProblemDetailsException({
        type: '/errores/servicio-no-disponible',
        title: 'Servicio no disponible',
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
        correlationId,
      });
    const { rows, total } = await this.database
      .transaction(async (tx) => {
        await tx.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        const classified = `WITH saldo AS (
          SELECT s.sku_id AS sku, l.id AS "locationId", l.code AS "locationCode",
                 l.name AS "locationName", l.type AS "locationType", l.active AS "locationActive",
                 sl.active AS "skuActivo", s.on_hand AS "onHand", s.reserved, s.blocked,
                 s.available, s.stock_version::text AS "stockVersion", s.updated_at AS "updatedAt",
                 COALESCE(
                   (SELECT t.umbral_efectivo FROM inventory.stock_threshold_override t
                    WHERE t.sku_id = s.sku_id AND t.location_id IS NULL),
                   global_threshold.umbral_efectivo, $3::int
                 ) AS "umbralEfectivo"
          FROM inventory.stock_balance s
          JOIN inventory.locations l ON l.id = s.location_id
          LEFT JOIN inventory.sku_lifecycle sl ON sl.sku_id = s.sku_id
          LEFT JOIN inventory.stock_threshold_override global_threshold
            ON global_threshold.sku_id IS NULL AND global_threshold.location_id IS NULL
          WHERE ($1::text IS NULL OR s.sku_id = $1)
            AND ($2::uuid IS NULL OR s.location_id = $2)
        ), clasificado AS (
          SELECT saldo.*, CASE
            WHEN available = 0 THEN 'AGOTADO'
            WHEN available <= "umbralEfectivo" THEN 'STOCK_BAJO'
            ELSE 'DISPONIBLE'
          END AS estado FROM saldo
        )`;
        const filter =
          'FROM clasificado WHERE ($4::text IS NULL OR estado = $4)';
        const { rows: counts } = await tx.query<{ total: string }>(
          `${classified} SELECT count(*)::text AS total ${filter}`,
          params,
        );
        const { rows } = await tx.query<SaldoFisicoRow>(
          `${classified} SELECT * ${filter} ORDER BY sku, "locationId" LIMIT $5 OFFSET $6`,
          [...params, tamanio, (pagina - 1) * tamanio],
        );
        return { rows, total: Number(counts[0]?.total) };
      })
      .catch(() => {
        throw unavailable();
      });
    if (!Number.isSafeInteger(total) || total < 0) throw unavailable();
    const items = rows.map((row) => {
      const stockVersion = Number(row.stockVersion);
      if (!Number.isSafeInteger(stockVersion) || stockVersion < 0)
        throw unavailable();
      return {
        sku: row.sku,
        ubicacion: {
          locationId: row.locationId,
          codigo: row.locationCode,
          nombre: row.locationName,
          tipo: row.locationType,
          activa: row.locationActive,
        },
        skuActivo: row.skuActivo,
        onHand: row.onHand,
        reserved: row.reserved,
        blocked: row.blocked,
        available: row.available,
        umbralEfectivo: row.umbralEfectivo,
        estado: row.estado,
        stockVersion,
        actualizadoEn: row.updatedAt.toISOString(),
      };
    });
    return {
      items,
      meta: {
        pagina,
        tamanio,
        total,
        totalPaginas: Math.ceil(total / tamanio),
      },
    };
  }

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
