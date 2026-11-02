import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IncidenciasService } from './incidencias.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import {
  CrearIncidenciaInventarioRequest,
  ResolverIncidenciaInventarioRequest,
} from '../types/inventory.dto.js';
import { DrizzleStockBalanceRepository } from '../repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleOperationsRepository } from '../repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleLocationsRepository } from '../repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleKardexRepository } from '../repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';
import { DrizzleIncidentsRepository } from '../repositories/drizzle/drizzle-incidents.repository.js';
import { DrizzleTrasladosRepository } from '../repositories/drizzle/drizzle-traslados.repository.js';

describe('IncidenciasService — cuarentenas físicas (SPEC-015)', () => {
  let service: IncidenciasService;
  let mockDb: InMemoryDatabaseMock;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
  const sku = 'NIK-REV7-NEG-41';
  const retail = 'modulo-retail';

  function reporte(
    overrides: Partial<CrearIncidenciaInventarioRequest> = {},
  ): CrearIncidenciaInventarioRequest {
    return {
      operation_id: randomUUID(),
      external_incident_id: 'INC-EXT-001',
      sku,
      quantity: 2,
      location_id: locLurin,
      type: 'DANIO',
      occurred_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function resolucion(
    overrides: Partial<ResolverIncidenciaInventarioRequest> = {},
  ): ResolverIncidenciaInventarioRequest {
    return {
      operation_id: randomUUID(),
      resolution: 'REHABILITADO',
      act_ref: 'ACTA-001',
      ...overrides,
    };
  }

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    service = new IncidenciasService(
      dbService,
      new IdempotencyService(),
      new KardexService(new DrizzleKardexRepository(dbService)),
      new OutboxService(new DrizzleOutboxRepository(dbService)),
      new DrizzleOperationsRepository(dbService),
      new DrizzleStockBalanceRepository(dbService),
      new DrizzleLocationsRepository(dbService),
      new DrizzleIncidentsRepository(dbService),
      new DrizzleTrasladosRepository(dbService),
    );
  });

  it('reportar bloquea unidades disponibles sin reducir on_hand', async () => {
    const dto = reporte();
    const res = await service.reportarIncidencia(
      dto,
      undefined,
      dto.operation_id,
      retail,
    );

    expect(res.estado).toBe('ABIERTA');
    expect(res.type).toBe('DANIO');
    expect(res.on_hand).toBe(18);
    expect(res.blocked).toBe(2);
    expect(res.available).toBe(16);

    const bal = mockDb.stockBalance.find((b) => b.sku_id === sku)!;
    expect(bal.on_hand).toBe(18);
    expect(bal.blocked).toBe(2);
    expect(bal.available).toBe(16);

    expect(mockDb.incidencias).toHaveLength(1);
    expect(mockDb.kardex[0].operation_type).toBe('INCIDENCIA_BLOQUEO');
    expect(
      mockDb.outbox.filter((o) => o.event_type === 'inventory.stock.changed'),
    ).toHaveLength(1);
  });

  it('rechaza bloquear más unidades que las disponibles (409 STOCK_INSUFICIENTE)', async () => {
    const dto = reporte({ quantity: 100 });
    await expect(
      service.reportarIncidencia(dto, undefined, dto.operation_id, retail),
    ).rejects.toMatchObject({
      problem: { status: 409, code: 'STOCK_INSUFICIENTE' },
    });
    expect(mockDb.incidencias).toHaveLength(0);
  });

  it('un reintento idéntico no duplica la incidencia ni el bloqueo', async () => {
    const dto = reporte();
    const key = dto.operation_id;
    const first = await service.reportarIncidencia(dto, undefined, key, retail);
    const second = await service.reportarIncidencia(
      dto,
      undefined,
      key,
      retail,
    );

    expect(second).toEqual(first);
    expect(mockDb.incidencias).toHaveLength(1);
    expect(mockDb.kardex).toHaveLength(1);
  });

  it('REHABILITADO libera el bloqueo sin cambiar on_hand', async () => {
    const rep = reporte();
    const created = await service.reportarIncidencia(
      rep,
      undefined,
      rep.operation_id,
      retail,
    );

    const res = resolucion({ resolution: 'REHABILITADO' });
    const out = await service.resolverIncidencia(
      created.incidencia_id,
      res,
      undefined,
      res.operation_id,
      retail,
    );

    expect(out.estado).toBe('RESUELTA');
    expect(out.resolution).toBe('REHABILITADO');
    expect(out.on_hand).toBe(18);
    expect(out.blocked).toBe(0);
    expect(out.type).toBe('DANIO');

    const bal = mockDb.stockBalance.find((b) => b.sku_id === sku)!;
    expect(bal.on_hand).toBe(18);
    expect(bal.blocked).toBe(0);
    expect(mockDb.traslados).toHaveLength(0);
  });

  it('MERMA reduce blocked y on_hand', async () => {
    const rep = reporte();
    const created = await service.reportarIncidencia(
      rep,
      undefined,
      rep.operation_id,
      retail,
    );
    const res = resolucion({ resolution: 'MERMA' });
    const out = await service.resolverIncidencia(
      created.incidencia_id,
      res,
      undefined,
      res.operation_id,
      retail,
    );

    expect(out.on_hand).toBe(16);
    expect(out.blocked).toBe(0);
    const bal = mockDb.stockBalance.find((b) => b.sku_id === sku)!;
    expect(bal.on_hand).toBe(16);
  });

  it('TRASLADO_ALMACEN_CENTRAL descuenta el origen y crea un traslado EN_TRANSITO', async () => {
    const rep = reporte();
    const created = await service.reportarIncidencia(
      rep,
      undefined,
      rep.operation_id,
      retail,
    );
    const res = resolucion({
      resolution: 'TRASLADO_ALMACEN_CENTRAL',
      target_location_id: locMiraflores,
    });
    const out = await service.resolverIncidencia(
      created.incidencia_id,
      res,
      undefined,
      res.operation_id,
      retail,
    );

    expect(out.estado).toBe('TRASLADO_PENDIENTE');
    expect(out.transfer_ref).toBeTruthy();
    expect(out.on_hand).toBe(16);
    expect(out.blocked).toBe(0);

    expect(mockDb.traslados).toHaveLength(1);
    expect(mockDb.traslados[0].estado).toBe('EN_TRANSITO');
    expect(mockDb.traslados[0].quantity_shipped).toBe(2);
    expect(mockDb.traslados[0].source_location_id).toBe(locLurin);
    expect(mockDb.traslados[0].target_location_id).toBe(locMiraflores);
  });

  it('resolver una incidencia inexistente responde 404', async () => {
    const res = resolucion();
    await expect(
      service.resolverIncidencia(
        randomUUID(),
        res,
        undefined,
        res.operation_id,
        retail,
      ),
    ).rejects.toMatchObject({
      problem: { status: 404, code: 'INCIDENCIA_NO_ENCONTRADA' },
    });
  });

  it('resolver una incidencia ya resuelta responde 409 INCIDENCIA_NO_ACTIVA', async () => {
    const rep = reporte();
    const created = await service.reportarIncidencia(
      rep,
      undefined,
      rep.operation_id,
      retail,
    );
    const r1 = resolucion();
    await service.resolverIncidencia(
      created.incidencia_id,
      r1,
      undefined,
      r1.operation_id,
      retail,
    );

    const r2 = resolucion();
    await expect(
      service.resolverIncidencia(
        created.incidencia_id,
        r2,
        undefined,
        r2.operation_id,
        retail,
      ),
    ).rejects.toMatchObject({
      problem: { status: 409, code: 'INCIDENCIA_NO_ACTIVA' },
    });
  });

  it('TRASLADO sin target_location_id responde 422 RESOLUCION_INCIDENCIA_INVALIDA', async () => {
    const res = resolucion({ resolution: 'TRASLADO_ALMACEN_CENTRAL' });
    await expect(
      service.resolverIncidencia(
        randomUUID(),
        res,
        undefined,
        res.operation_id,
        retail,
      ),
    ).rejects.toMatchObject({
      problem: { status: 422, code: 'RESOLUCION_INCIDENCIA_INVALIDA' },
    });
  });
});
