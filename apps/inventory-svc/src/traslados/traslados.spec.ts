import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TrasladosService } from './traslados.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { RecepcionTrasladoInventarioRequest } from '../types/inventory.dto.js';
import { DrizzleStockBalanceRepository } from '../repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleOperationsRepository } from '../repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleKardexRepository } from '../repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';
import { DrizzleTrasladosRepository } from '../repositories/drizzle/drizzle-traslados.repository.js';

describe('TrasladosService — consultas y recepciones (SPEC-015)', () => {
  let service: TrasladosService;
  let mockDb: InMemoryDatabaseMock;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const locMiraflores = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
  const skuNik = 'NIK-REV7-NEG-41';
  const skuPuma = 'PUM-LIMIT-01';
  const gestorSub = 'gestor-inventario-1';

  function seedTraslado(
    overrides: Partial<InMemoryDatabaseMock['traslados'][number]> = {},
  ) {
    const row = {
      id: randomUUID(),
      traslado_id: randomUUID(),
      source_incident_id: randomUUID(),
      sku_id: skuNik,
      source_location_id: locLurin,
      target_location_id: locMiraflores,
      quantity_shipped: 5,
      quantity_received: 0,
      missing_quantity: null,
      estado: 'EN_TRANSITO' as const,
      created_at: '2026-10-16T12:00:00.000Z',
      updated_at: '2026-10-16T12:00:00.000Z',
      ...overrides,
    };
    mockDb.traslados.push(row);
    return row;
  }

  function recepcion(
    overrides: Partial<RecepcionTrasladoInventarioRequest> = {},
  ): RecepcionTrasladoInventarioRequest {
    return {
      operation_id: randomUUID(),
      received_quantity: 2,
      disposition: 'REINGRESAR_DISPONIBLE',
      final_receipt: false,
      received_at: '2026-10-16T13:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    const dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    service = new TrasladosService(
      dbService,
      new IdempotencyService(),
      new KardexService(new DrizzleKardexRepository(dbService)),
      new OutboxService(new DrizzleOutboxRepository(dbService)),
      new DrizzleOperationsRepository(dbService),
      new DrizzleStockBalanceRepository(dbService),
      new DrizzleTrasladosRepository(dbService),
    );
  });

  it('lista traslados con filtros y paginación', async () => {
    seedTraslado();
    seedTraslado({
      traslado_id: randomUUID(),
      estado: 'RECIBIDO_PARCIAL',
      target_location_id: locLurin,
    });
    seedTraslado({ traslado_id: randomUUID() });

    const res = await service.listarTraslados({
      estado: 'EN_TRANSITO',
      target_location_id: locMiraflores,
      pagina: 1,
      tamanio: 1,
    });

    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(1);
    expect(res.pagina).toBe(1);
    expect(res.tamanio).toBe(1);
    expect(res.items[0].estado).toBe('EN_TRANSITO');
  });

  it('obtiene el detalle de un traslado y responde 404 si no existe', async () => {
    const traslado = seedTraslado();
    const found = await service.obtenerTraslado(traslado.traslado_id);
    expect(found.sku).toBe(skuNik);
    expect(found.quantity_shipped).toBe(5);

    await expect(service.obtenerTraslado(randomUUID())).rejects.toMatchObject({
      problem: { status: 404, code: 'TRASLADO_NO_ENCONTRADO' },
    });
  });

  it('REINGRESAR_DISPONIBLE acredita on_hand y completa la recepción parcial', async () => {
    const traslado = seedTraslado();
    const dto = recepcion({ received_quantity: 2 });
    const result = await service.registrarRecepcion(
      traslado.traslado_id,
      dto,
      undefined,
      'recepcion-disponible-001',
      gestorSub,
    );

    expect(result.traslado.estado).toBe('RECIBIDO_PARCIAL');
    expect(result.traslado.quantity_received).toBe(2);
    expect(result.traslado.missing_quantity).toBe(3);
    expect(result.destination_balance?.on_hand).toBe(6);
    expect(result.destination_balance?.blocked).toBe(0);
    expect(result.destination_balance?.available).toBe(6);
    expect(mockDb.kardex.at(-1)?.operation_type).toBe('RECEPCION_TRASLADO');
    expect(
      mockDb.outbox.filter(
        (row) => row.event_type === 'inventory.stock.changed',
      ),
    ).toHaveLength(1);
  });

  it('REINGRESAR_BLOQUEADO crea saldo en destino y conserva la cuarentena', async () => {
    const traslado = seedTraslado({ sku_id: skuPuma });
    const dto = recepcion({
      received_quantity: 1,
      disposition: 'REINGRESAR_BLOQUEADO',
      final_receipt: true,
    });
    const result = await service.registrarRecepcion(
      traslado.traslado_id,
      dto,
      undefined,
      'recepcion-bloqueado-001',
      gestorSub,
    );

    expect(result.traslado.estado).toBe('COMPLETADO_CON_DISCREPANCIA');
    expect(result.destination_balance).toMatchObject({
      sku: skuPuma,
      on_hand: 1,
      blocked: 1,
      available: 0,
      status: 'AGOTADO',
    });
    expect(
      mockDb.stockBalance.find(
        (row) => row.sku_id === skuPuma && row.location_id === locMiraflores,
      ),
    ).toMatchObject({ on_hand: 1, blocked: 1, available: 0 });
  });

  it('CONFIRMAR_MERMA no acredita stock en destino', async () => {
    const traslado = seedTraslado({ sku_id: skuPuma });
    const dto = recepcion({
      received_quantity: 2,
      disposition: 'CONFIRMAR_MERMA',
      final_receipt: false,
    });
    const result = await service.registrarRecepcion(
      traslado.traslado_id,
      dto,
      undefined,
      'recepcion-merma-001',
      gestorSub,
    );

    expect(result.destination_balance).toBeNull();
    expect(
      mockDb.stockBalance.some(
        (row) => row.sku_id === skuPuma && row.location_id === locMiraflores,
      ),
    ).toBe(false);
    expect(mockDb.outbox).toHaveLength(0);
    expect(result.traslado.estado).toBe('RECIBIDO_PARCIAL');
  });

  it('cierra como COMPLETADO cuando se recibe todo, aunque final_receipt sea false', async () => {
    const traslado = seedTraslado({ quantity_shipped: 2 });
    const dto = recepcion({ received_quantity: 2, final_receipt: false });
    const result = await service.registrarRecepcion(
      traslado.traslado_id,
      dto,
      undefined,
      'recepcion-total-001',
      gestorSub,
    );

    expect(result.traslado.estado).toBe('COMPLETADO');
    expect(result.traslado.missing_quantity).toBe(0);
  });

  it('un reintento idéntico devuelve el resultado durable sin duplicar efectos', async () => {
    const traslado = seedTraslado();
    const dto = recepcion({ received_quantity: 2 });
    const key = 'recepcion-replay-001';
    const first = await service.registrarRecepcion(
      traslado.traslado_id,
      dto,
      undefined,
      key,
      gestorSub,
    );
    const retry = await service.registrarRecepcion(
      traslado.traslado_id,
      dto,
      undefined,
      key,
      gestorSub,
    );

    expect(retry).toEqual(first);
    expect(mockDb.trasladoRecepciones).toHaveLength(1);
    expect(mockDb.operations).toHaveLength(1);
    expect(mockDb.kardex).toHaveLength(1);
  });

  it('rechaza cantidades superiores a las pendientes y traslados cerrados', async () => {
    const traslado = seedTraslado({
      estado: 'COMPLETADO',
      quantity_received: 5,
    });
    const dto = recepcion({ received_quantity: 1 });
    await expect(
      service.registrarRecepcion(
        traslado.traslado_id,
        dto,
        undefined,
        'recepcion-cerrado-001',
        gestorSub,
      ),
    ).rejects.toMatchObject({
      problem: { status: 409, code: 'TRASLADO_NO_RECIBIBLE' },
    });

    mockDb.traslados[0].estado = 'EN_TRANSITO';
    mockDb.traslados[0].quantity_received = 4;
    const tooMany = recepcion({ received_quantity: 2 });
    await expect(
      service.registrarRecepcion(
        traslado.traslado_id,
        tooMany,
        undefined,
        'recepcion-exceso-001',
        gestorSub,
      ),
    ).rejects.toMatchObject({
      problem: { status: 422, code: 'CANTIDAD_RECIBIDA_EXCEDE_TRASLADO' },
    });
  });
});
