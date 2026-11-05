import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventorySvcModule } from '../inventory-svc.module.js';
import { DatabaseService } from '../database/database.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { AbsoluteStockAdjustmentService } from './absolute-stock-adjustment.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('Ajuste absoluto interno Bulk', () => {
  let service: AbsoluteStockAdjustmentService;
  let database: InMemoryDatabaseMock;
  let outbox: OutboxService;
  const locationId = '9129b578-631e-1735-8427-b683fb524380';

  const input = () => ({
    operation_id: randomUUID(),
    sku: 'NIK-REV7-NEG-41',
    location_id: locationId,
    expected_stock_version: 1,
    target_on_hand: 12,
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();
    database = new InMemoryDatabaseMock();
    module.get(DatabaseService).setCustomService(database);
    service = module.get(AbsoluteStockAdjustmentService);
    outbox = module.get(OutboxService);
  });

  it('aplica el target con versión esperada, Kardex y Outbox en una transacción', async () => {
    const command = input();
    expect(await service.apply(command)).toMatchObject({
      status: 'APPLIED',
      on_hand: 12,
      reserved: 0,
      blocked: 0,
      available: 12,
      stock_version: 2,
    });
    expect(database.stockBalance[0]).toMatchObject({
      on_hand: 12,
      stock_version: 2,
    });
    expect(database.kardex).toHaveLength(1);
    expect(database.kardex[0]).toMatchObject({
      operation_type: 'AJUSTE_ABSOLUTO',
      quantity: -6,
      operation_id: command.operation_id,
    });
    expect(
      database.outbox.filter(
        (row) => row.event_type === 'inventory.stock.changed',
      ),
    ).toHaveLength(1);
  });

  it('replay devuelve resultado durable sin descontar ni publicar de nuevo', async () => {
    const command = input();
    const first = await service.apply(command);
    expect(await service.apply(command)).toEqual(first);
    expect(database.stockBalance[0].on_hand).toBe(12);
    expect(database.operations).toHaveLength(1);
    expect(database.kardex).toHaveLength(1);
    expect(database.outbox).toHaveLength(1);
  });

  it('rechaza versión obsoleta y protege reserved/blocked ante targets insuficientes', async () => {
    const command = input();
    expect(
      await service.apply({ ...command, expected_stock_version: 0 }),
    ).toMatchObject({
      status: 'REJECTED',
      code: 'VERSION_STALE',
    });
    const row = database.stockBalance[0];
    row.reserved = 4;
    row.blocked = 2;
    const rejected = await service.apply({
      ...input(),
      expected_stock_version: row.stock_version,
      target_on_hand: 5,
    });
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      code: 'TARGET_BELOW_COMMITTED_UNITS',
    });
    expect(row).toMatchObject({ on_hand: 18, reserved: 4, blocked: 2 });
  });

  it('revierte saldo, Kardex y operación si Outbox falla', async () => {
    const command = input();
    vi.spyOn(outbox, 'stockChanged').mockRejectedValueOnce(
      new Error('outbox unavailable'),
    );
    await expect(service.apply(command)).rejects.toThrow('outbox unavailable');
    expect(database.stockBalance[0]).toMatchObject({
      on_hand: 18,
      stock_version: 1,
    });
    expect(database.operations).toHaveLength(0);
    expect(database.kardex).toHaveLength(0);
    expect(database.outbox).toHaveLength(0);
  });
});
