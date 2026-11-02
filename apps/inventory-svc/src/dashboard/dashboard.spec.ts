import { describe, it, expect, beforeEach } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { DrizzleStockBalanceRepository } from '../repositories/drizzle/drizzle-stock-balance.repository.js';

describe('DashboardService — indicadores y distribución (SPEC-016)', () => {
  let service: DashboardService;
  let mockDb: InMemoryDatabaseMock;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
  const skuNik = 'NIK-REV7-NEG-41';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    service = new DashboardService(
      new DrizzleStockBalanceRepository(dbService),
    );
  });

  it('calcula totales, estados por SKU y distribución por ubicación', async () => {
    const res = await service.obtenerDashboard({});

    expect(res.totalSkus).toBe(3);
    expect(res.totalOnHand).toBe(34);
    expect(res.totalReserved).toBe(0);
    expect(res.totalAvailable).toBe(34);
    expect(res.skusDisponibles).toBe(2);
    expect(res.skusStockBajo).toBe(1);
    expect(res.skusAgotados).toBe(0);

    const lurin = res.porUbicacion.find((u) => u.location_id === locLurin)!;
    expect(lurin.on_hand).toBe(30);
    expect(lurin.available).toBe(30);
    expect(lurin.skusDisponibles).toBe(2);
    expect(lurin.skusStockBajo).toBe(1);

    const miraflores = res.porUbicacion.find(
      (u) => u.location_id === locMiraflores,
    )!;
    expect(miraflores.on_hand).toBe(4);
    expect(miraflores.skusStockBajo).toBe(1);
  });

  it('filtra por SKU', async () => {
    const res = await service.obtenerDashboard({ sku: skuNik });
    expect(res.totalSkus).toBe(1);
    expect(res.totalAvailable).toBe(22);
    expect(res.skusDisponibles).toBe(1);
  });

  it('filtra por ubicación', async () => {
    const res = await service.obtenerDashboard({ locationId: locLurin });
    expect(res.totalSkus).toBe(3);
    expect(res.totalAvailable).toBe(30);
    expect(res.porUbicacion).toHaveLength(1);
  });

  it('aplica el umbral global a la clasificación', async () => {
    mockDb.thresholdOverrides = [
      { id: 't-global', sku_id: null, location_id: null, umbral_efectivo: 30 },
    ];
    const res = await service.obtenerDashboard({});
    expect(res.skusDisponibles).toBe(0);
    expect(res.skusStockBajo).toBe(3);
  });

  it('el override por SKU prevalece sobre el global', async () => {
    mockDb.thresholdOverrides = [
      { id: 't-global', sku_id: null, location_id: null, umbral_efectivo: 3 },
      { id: 't-nik', sku_id: skuNik, location_id: null, umbral_efectivo: 100 },
    ];
    const res = await service.obtenerDashboard({});
    // NIK (22) queda como STOCK_BAJO por su override 100; ADI (10) y PUM (2) con global 3.
    expect(res.skusStockBajo).toBe(2); // NIK + PUM
    expect(res.skusDisponibles).toBe(1); // ADI
  });

  it('rechaza filtros de catálogo que no puede aplicar (400 VALIDACION)', async () => {
    await expect(
      service.obtenerDashboard({ productoId: 'prod-1' }),
    ).rejects.toMatchObject({ problem: { status: 400, code: 'VALIDACION' } });
  });
});
