import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventorySvcModule } from '../inventory-svc.module.js';
import { DatabaseService } from '../database/database.service.js';
import { OfflineReconciliationService } from './offline-reconciliation.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import type { ConciliacionOfflineRequest } from '../types/inventory.dto.js';

describe('Conciliación offline interna (sin ruta HTTP)', () => {
  let service: OfflineReconciliationService;
  let database: InMemoryDatabaseMock;
  const locationId = '9129b578-631e-1735-8427-b683fb524380';
  const sku = 'NIK-REV7-NEG-41';
  const context = {
    client_id: 'modulo-ventas' as const,
    actor_ref: 'VENTAS-OPERADOR-1',
    store_ref: 'TIENDA-MIRAFLORES',
    location_id: locationId,
    authorized: true as const,
  };
  const request = (): ConciliacionOfflineRequest => ({
    operation_id: randomUUID(),
    order_id: `ORD-${randomUUID()}`,
    offline_sale_id: `SALE-${randomUUID()}`,
    channel_id: 'RETAIL',
    occurred_at: new Date().toISOString(),
    lines: [{ sku, quantity: 20, location_id: locationId }],
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();
    database = new InMemoryDatabaseMock();
    module.get(DatabaseService).setCustomService(database);
    service = module.get(OfflineReconciliationService);
  });

  it('aplica solo disponibilidad, informa faltante y registra un movimiento real', async () => {
    database.stockBalance[0].reserved = 4;
    database.stockBalance[0].blocked = 2;
    const sale = request();
    const result = await service.reconcileResolvedSale(
      'modulo-ventas',
      sale,
      context,
    );
    expect(result).toMatchObject({
      operation_id: sale.operation_id,
      status: 'REQUIRES_REVIEW',
      lines: [
        {
          sku,
          requested_quantity: 20,
          applied_quantity: 12,
          unresolved_quantity: 8,
          on_hand: 6,
          reserved: 4,
          blocked: 2,
          available: 0,
          stock_version: 2,
        },
      ],
    });
    expect(database.stockBalance[0]).toMatchObject({
      on_hand: 6,
      reserved: 4,
      blocked: 2,
    });
    expect(database.kardex).toHaveLength(1);
    expect(database.kardex[0]).toMatchObject({
      operation_type: 'CONCILIACION_OFFLINE',
      quantity: -12,
    });
    expect(database.offlineSaleReconciliations).toHaveLength(1);
  });

  it('deduplica la venta aun con un operation_id técnico distinto', async () => {
    const sale = request();
    const first = await service.reconcileResolvedSale(
      'modulo-ventas',
      sale,
      context,
    );
    const balanceAfterFirst = structuredClone(database.stockBalance[0]);
    const replay = await service.reconcileResolvedSale(
      'modulo-ventas',
      { ...sale, operation_id: randomUUID() },
      context,
    );
    expect(replay).toEqual(first);
    expect(database.stockBalance[0]).toEqual(balanceAfterFirst);
    expect(database.operations).toHaveLength(1);
    expect(database.kardex).toHaveLength(1);
  });

  it('rechaza contenido distinto para una venta ya conciliada', async () => {
    const sale = request();
    await service.reconcileResolvedSale('modulo-ventas', sale, context);
    await expect(
      service.reconcileResolvedSale(
        'modulo-ventas',
        { ...sale, lines: [{ ...sale.lines[0], quantity: 1 }] },
        context,
      ),
    ).rejects.toThrow('ya fue conciliada');
  });

  it('exige contexto autorizado de Ventas y ubicación resuelta activa antes de mutar', async () => {
    const sale = request();
    await expect(
      service.reconcileResolvedSale('modulo-retail', sale, context),
    ).rejects.toThrow('Contexto de tienda/ubicación');
    await expect(
      service.reconcileResolvedSale('modulo-ventas', sale, {
        ...context,
        location_id: 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485',
      }),
    ).rejects.toThrow('no corresponde a la ubicación resuelta');
    expect(database.stockBalance[0].on_hand).toBe(18);
    expect(database.kardex).toHaveLength(0);
  });

  it('no crea Kardex para una venta sin saldo en esa ubicación', async () => {
    const sale = request();
    sale.lines[0].sku = 'SKU-SIN-SALDO';
    const result = await service.reconcileResolvedSale(
      'modulo-ventas',
      sale,
      context,
    );
    expect(result).toMatchObject({
      status: 'REQUIRES_REVIEW',
      lines: [{ applied_quantity: 0, unresolved_quantity: 20, on_hand: 0 }],
    });
    expect(database.kardex).toHaveLength(0);
    expect(database.outbox).toHaveLength(0);
  });
});
