import { Injectable, Inject } from '@nestjs/common';
import { loadInventoryConfig } from '../config/inventory.config.js';
import { DatabaseService } from '../database/database.service.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import {
  DashboardInventario,
  DashboardUbicacion,
} from '../types/inventory.dto.js';
import { STOCK_BALANCE_REPOSITORY } from '../repositories/interfaces/repository.tokens.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';

type EstadoStock = 'DISPONIBLE' | 'STOCK_BAJO' | 'AGOTADO';

function clasificarSaldo(available: number, threshold: number): EstadoStock {
  if (available <= 0) return 'AGOTADO';
  if (available <= threshold) return 'STOCK_BAJO';
  return 'DISPONIBLE';
}

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

/** SPEC-016 metrics kept internal until OpenAPI approves an expanded DTO. */
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

@Injectable()
export class DashboardService {
  constructor(
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stockBalanceRepository: IStockBalanceRepository,
    private readonly database: DatabaseService,
  ) {}

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
    const dashboard = await this.obtenerDashboard(filtros);
    const rows = await this.stockBalanceRepository.findByFilters({
      sku: filtros.sku,
      locationId: filtros.locationId,
    });
    const transfers = await this.database.query<{
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
    );
    return {
      unidadesFisicas: dashboard.totalOnHand,
      unidadesReservadas: dashboard.totalReserved,
      unidadesBloqueadas: rows.reduce((sum, row) => sum + row.blocked, 0),
      unidadesDisponibles: dashboard.totalAvailable,
      skuPorEstado: {
        DISPONIBLE: dashboard.skusDisponibles,
        STOCK_BAJO: dashboard.skusStockBajo,
        AGOTADO: dashboard.skusAgotados,
      },
      trasladosPendientes: Number(transfers.rows[0]?.pendientes ?? 0),
      trasladosConDiscrepancia: Number(transfers.rows[0]?.discrepancias ?? 0),
    };
  }

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
      const estado = clasificarSaldo(row.available, thresholdFor(row.sku_id));
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
      const estado = clasificarSaldo(agg.available, thresholdFor(sku));
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
