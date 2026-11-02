import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventorySvcModule } from '../inventory-svc.module.js';
import { DatabaseService } from '../database/database.service.js';
import { InventoryCommandService } from './inventory-command.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('Inicialización SKU — Inbox/operación/Outbox atómicos (#102)', () => {
  let service: InventoryCommandService;
  let db: InMemoryDatabaseMock;
  let outbox: OutboxService;
  const location = '9129b578-631e-1735-8427-b683fb524380';
  const message = () => ({
    message_id: randomUUID(),
    operation_id: randomUUID(),
    correlation_id: randomUUID(),
    schema_version: 2,
    occurred_at: new Date().toISOString(),
    kind: 'command',
    producer: 'catalog-svc',
    name: 'inventory.sku.initialization.requested',
    data: {
      sku: 'SKU-NUEVO',
      product_id: 'PRODUCTO-NUEVO',
      default_location_id: location,
    },
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();
    db = new InMemoryDatabaseMock();
    module.get(DatabaseService).setCustomService(db);
    service = module.get(InventoryCommandService);
    outbox = module.get(OutboxService);
  });

  it('inicializa en cero, guarda resultado durable y correlaciona el resultado con el intento', async () => {
    const command = message();
    expect(await service.process(command)).toEqual({
      duplicate: false,
      status: 'INITIALIZED',
    });
    expect(
      db.stockBalance.find((row) => row.sku_id === command.data.sku),
    ).toMatchObject({
      on_hand: 0,
      reserved: 0,
      blocked: 0,
      available: 0,
      stock_version: 0,
    });
    expect(db.inbox[0].status).toBe('PROCESSED');
    expect(db.operations[0].operation_id).toBe(command.operation_id);
    const result = db.outbox.find(
      (row) => row.event_type === 'inventory.sku.initialization.completed',
    )!;
    expect(result.payload).toMatchObject({
      operation_id: command.operation_id,
      causation_id: command.message_id,
      correlation_id: command.correlation_id,
      kind: 'result',
      data: { status: 'INITIALIZED', code: null },
    });
    expect(db.kardex).toHaveLength(0); // No movimiento artificial de cantidad cero.
  });

  it('el mismo message_id no repite efectos ni resultados', async () => {
    const command = message();
    await service.process(command);
    const before = structuredClone({
      stock: db.stockBalance,
      operations: db.operations,
      outbox: db.outbox,
    });
    expect(await service.process(command)).toEqual({ duplicate: true });
    expect({
      stock: db.stockBalance,
      operations: db.operations,
      outbox: db.outbox,
    }).toEqual(before);
  });

  it('otro intento con la misma operación conserva el resultado y usa la nueva causation_id', async () => {
    const command = message();
    await service.process(command);
    const replay = { ...command, message_id: randomUUID() };
    await service.process(replay);
    expect(db.operations).toHaveLength(1);
    const results = db.outbox.filter(
      (row) => row.event_type === 'inventory.sku.initialization.completed',
    );
    expect(results).toHaveLength(2);
    expect(results[1].payload.causation_id).toBe(replay.message_id);
    expect(results[1].payload.data).toEqual(results[0].payload.data);
    expect(
      db.outbox.filter((row) => row.event_type === 'inventory.stock.changed'),
    ).toHaveLength(1);
  });

  it('no reinicia un saldo existente aunque reciba otra operación de inicialización', async () => {
    const command = message();
    command.data.sku = 'NIK-REV7-NEG-41';
    const before = structuredClone(db.stockBalance);
    await service.process(command);
    expect(db.stockBalance).toEqual(before);
    expect(
      db.outbox.some((row) => row.event_type === 'inventory.stock.changed'),
    ).toBe(false);
  });

  it('reutilizar operation_id con otro SKU rechaza sin inicializar el segundo SKU', async () => {
    const command = message();
    await service.process(command);
    await service.process({
      ...command,
      message_id: randomUUID(),
      data: { ...command.data, sku: 'OTRO-SKU' },
    });
    expect(db.stockBalance.some((row) => row.sku_id === 'OTRO-SKU')).toBe(
      false,
    );
    expect(db.operations).toHaveLength(1);
    expect(db.outbox.at(-1)?.payload.data).toMatchObject({
      status: 'REJECTED',
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('rechazo de negocio por ubicación no activa se confirma durablemente sin crear saldo', async () => {
    db.locations.find((row) => row.id === location)!.active = false;
    const command = message();
    expect(await service.process(command)).toMatchObject({
      status: 'REJECTED',
    });
    expect(db.inbox[0].status).toBe('PROCESSED');
    expect(db.operations[0].status).toBe('RECHAZADO');
    expect(db.outbox[0].payload.data.code).toBe('UBICACION_NO_ENCONTRADA');
    expect(db.stockBalance.some((row) => row.sku_id === command.data.sku)).toBe(
      false,
    );
  });

  it('un fallo técnico revierte Inbox/saldo/operación/Outbox y permite recuperar el mensaje', async () => {
    const command = message();
    const before = structuredClone(db.stockBalance);
    vi.spyOn(outbox, 'enqueue').mockRejectedValueOnce(
      new Error('fallo técnico simulado'),
    );
    await expect(service.process(command)).rejects.toThrow(
      'fallo técnico simulado',
    );
    expect(db.inbox).toHaveLength(0);
    expect(db.operations).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
    expect(db.stockBalance).toEqual(before);
    await service.process(command);
    expect(db.inbox[0].status).toBe('PROCESSED');
  });

  it('no acepta cambiar el contenido de un mensaje ya procesado', async () => {
    const command = message();
    await service.process(command);
    const before = structuredClone(db.outbox);
    await expect(
      service.process({
        ...command,
        data: { ...command.data, sku: 'ALTERADO' },
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_MESSAGE' });
    expect(db.outbox).toEqual(before);
  });

  it('un resultado durable corrupto no se publica de nuevo como éxito', async () => {
    const command = message();
    await service.process(command);
    db.operations[0].result_payload = JSON.stringify({
      sku: command.data.sku,
      status: 'INITIALIZED',
    });
    const before = structuredClone(db.outbox);
    await expect(
      service.process({ ...command, message_id: randomUUID() }),
    ).rejects.toThrow('Resultado durable');
    expect(db.outbox).toEqual(before);
    expect(db.inbox).toHaveLength(1);
  });

  it('sin ubicación explícita rechaza la ambigüedad, y resuelve cuando solo queda una activa', async () => {
    const command = {
      ...message(),
      data: { sku: 'SIN-UBICACION', product_id: 'PRODUCTO' },
    };
    expect(await service.process(command)).toMatchObject({
      status: 'REJECTED',
    });
    for (const row of db.locations) row.active = row.id === location;
    expect(
      await service.process({
        ...command,
        operation_id: randomUUID(),
        message_id: randomUUID(),
      }),
    ).toMatchObject({ status: 'INITIALIZED' });
    expect(
      db.stockBalance.find((row) => row.sku_id === 'SIN-UBICACION')
        ?.location_id,
    ).toBe(location);
  });

  it.each(['inventory.bulk.stock.adjust.requested', 'catalog.sku.deactivated'])(
    'mantiene aislado un contrato sin payload ejecutable: %s',
    async (name) => {
      await expect(
        service.process({ ...message(), name }),
      ).rejects.toMatchObject({ reason: 'BLOCKED_CONTRACT' });
      expect(db.inbox).toHaveLength(0);
      expect(db.outbox).toHaveLength(0);
    },
  );
});
