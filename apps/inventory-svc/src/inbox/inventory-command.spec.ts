import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventorySvcModule } from '../inventory-svc.module.js';
import { DatabaseService } from '../database/database.service.js';
import { InventoryCommandService } from './inventory-command.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { DisponibilidadService } from '../disponibilidad/disponibilidad.service.js';
import { catalogPr185SkuDeactivatedEvent } from '../../test/catalog-pr185.fixture.js';

describe('Inicialización SKU — Inbox/operación/Outbox atómicos (#102)', () => {
  let service: InventoryCommandService;
  let db: InMemoryDatabaseMock;
  let outbox: OutboxService;
  let reservations: ReservationsService;
  let availability: DisponibilidadService;
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
    vi.stubEnv('INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED', 'false');
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();
    db = new InMemoryDatabaseMock();
    module.get(DatabaseService).setCustomService(db);
    service = module.get(InventoryCommandService);
    outbox = module.get(OutboxService);
    reservations = module.get(ReservationsService);
    availability = module.get(DisponibilidadService);
  });

  it('mantiene deshabilitado el handler de baja por defecto sin confirmar el mensaje', async () => {
    delete process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED;
    const event = {
      message_id: randomUUID(),
      operation_id: randomUUID(),
      correlation_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      kind: 'event',
      producer: 'catalog-svc',
      name: 'catalog.sku.deactivated',
      data: {
        sku: 'SKU-GATE',
        product_id: randomUUID(),
        sku_version: 1,
        changed_at: new Date().toISOString(),
      },
    };
    await expect(service.process(event)).rejects.toMatchObject({
      reason: 'FEATURE_DISABLED',
    });
    expect(db.inbox).toHaveLength(0);
    expect(db.skuLifecycle).toHaveLength(0);
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

  it('sin ubicación explícita confirma identidad sin crear saldo ni elegir una ubicación', async () => {
    const command = {
      ...message(),
      data: { sku: 'SIN-UBICACION', product_id: 'PRODUCTO' },
    };
    expect(await service.process(command)).toMatchObject({
      status: 'INITIALIZED',
    });
    expect(db.inbox[0].status).toBe('PROCESSED');
    expect(db.operations[0].status).toBe('APLICADO');
    expect(db.operations[0].request_payload).toMatchObject({
      sku: 'SIN-UBICACION',
      product_id: 'PRODUCTO',
    });
    expect(db.stockBalance.some((row) => row.sku_id === 'SIN-UBICACION')).toBe(
      false,
    );
    expect(db.outbox[0]?.payload.data).toMatchObject({
      sku: 'SIN-UBICACION',
      status: 'INITIALIZED',
      code: null,
    });
  });

  it('mantiene bloqueado inventory.bulk.stock.adjust.requested mientras su contrato siga en GenericData', async () => {
    await expect(
      service.process({
        ...message(),
        name: 'inventory.bulk.stock.adjust.requested',
      }),
    ).rejects.toMatchObject({ reason: 'BLOCKED_CONTRACT' });
    expect(db.inbox).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });

  it('acepta el envelope de Catalog PR #185 y evita reservas y disponibilidad positiva tras la baja', async () => {
    vi.stubEnv('INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED', 'true');
    const changedAt = new Date().toISOString();
    const sku = 'SKU-DESACTIVADO';
    const productId = randomUUID();
    const deactivation = catalogPr185SkuDeactivatedEvent({
      sku,
      productId,
      skuVersion: 3,
      changedAt,
    });
    expect(deactivation).toMatchObject({
      schema_version: 1,
      kind: 'event',
      producer: 'catalog-svc',
      name: 'catalog.sku.deactivated',
      causation_id: null,
      data: {
        product_id: productId,
        sku,
        sku_version: 3,
        changed_at: changedAt,
      },
    });
    expect(deactivation.message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(deactivation.operation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(deactivation.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(Number.isFinite(Date.parse(deactivation.occurred_at))).toBe(true);
    db.commercialRoutes.push({
      id: 'route-catalog-pr185',
      channel_id: 'MARKETPLACE',
      mode: 'ENVIO_DOMICILIO',
      fulfillment_ref: 'LIMA_METROPOLITANA',
      location_id: location,
      active: true,
    });
    db.stockBalance.push({
      sku_id: sku,
      location_id: location,
      on_hand: 9,
      reserved: 0,
      blocked: 0,
      available: 9,
      stock_version: 0,
    });
    const beforeStock = structuredClone(db.stockBalance);
    expect(
      await availability.consultarDisponibilidadComercial([sku], 'MARKETPLACE'),
    ).toEqual({ items: [{ sku, status: 'DISPONIBLE' }] });

    expect(await service.process(deactivation)).toEqual({ duplicate: false });
    expect(db.inbox[0]).toMatchObject({
      message_type: 'catalog.sku.deactivated',
      source: 'catalog-svc',
      status: 'PROCESSED',
    });
    expect(db.skuLifecycle).toEqual([
      {
        sku_id: sku,
        product_id: productId,
        sku_version: 3,
        active: false,
        changed_at: changedAt,
      },
    ]);
    expect(db.stockBalance).toEqual(beforeStock);
    expect(
      await availability.consultarDisponibilidadComercial([sku], 'MARKETPLACE'),
    ).toEqual({ items: [{ sku, status: 'INDETERMINADO' }] });
    expect(db.outbox).toHaveLength(0);
    expect(db.kardex).toHaveLength(0);
    await reservations.solicitarReserva(
      {
        order_id: 'ORD-SKU-INACTIVO',
        operation_id: randomUUID(),
        channel_id: 'MARKETPLACE',
        lines: [
          {
            sku,
            quantity: 1,
            location_id: location,
          },
        ],
      },
      undefined,
      randomUUID(),
      'modulo-ventas',
    );
    expect(db.operations.at(-1)?.result_code).toBe('SKU_INACTIVO');
    expect(db.stockBalance.find((row) => row.sku_id === sku)).toMatchObject({
      on_hand: 9,
      reserved: 0,
      blocked: 0,
      stock_version: 0,
    });
  });

  it('rechaza el payload legado de Catalog master anterior a PR #185', async () => {
    vi.stubEnv('INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED', 'true');
    // Catalog master a74b954 emitted {product_id, variant_id, sku}. Retain
    // this guard so a legacy producer is never mistaken for an rc.4 delivery.
    const legacyMasterEvent = {
      ...catalogPr185SkuDeactivatedEvent({
        sku: 'SKU-CATALOG-LEGADO',
        productId: randomUUID(),
        skuVersion: 1,
        changedAt: new Date().toISOString(),
      }),
      data: {
        product_id: randomUUID(),
        variant_id: randomUUID(),
        sku: 'SKU-CATALOG-LEGADO',
      },
    };
    const beforeStock = structuredClone(db.stockBalance);

    await expect(service.process(legacyMasterEvent)).rejects.toMatchObject({
      reason: 'INVALID_MESSAGE',
    });
    expect(db.inbox).toHaveLength(0);
    expect(db.skuLifecycle).toHaveLength(0);
    expect(db.stockBalance).toEqual(beforeStock);
  });

  it('deduplica message_id y no reactiva ni retrocede la versión por replay antiguo', async () => {
    vi.stubEnv('INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED', 'true');
    const changedAt = new Date().toISOString();
    const deactivation = {
      message_id: randomUUID(),
      operation_id: randomUUID(),
      correlation_id: randomUUID(),
      schema_version: 1,
      occurred_at: changedAt,
      kind: 'event',
      producer: 'catalog-svc',
      name: 'catalog.sku.deactivated',
      data: {
        sku: 'SKU-DESACTIVADO',
        product_id: randomUUID(),
        sku_version: 7,
        changed_at: changedAt,
      },
    };
    await service.process(deactivation);
    expect(await service.process(deactivation)).toEqual({ duplicate: true });
    await service.process({
      ...deactivation,
      message_id: randomUUID(),
      operation_id: randomUUID(),
      data: { ...deactivation.data, sku_version: 5 },
    });
    expect(db.skuLifecycle[0].sku_version).toBe(7);
    expect(db.skuLifecycle[0].active).toBe(false);
    expect(db.inbox).toHaveLength(2);
  });

  it.each([
    { producer: 'promotions-svc' },
    { schema_version: 2 },
    {
      data: {
        sku: 'SKU',
        product_id: randomUUID(),
        sku_version: 1,
        changed_at: new Date().toISOString(),
        extra: true,
      },
    },
  ])(
    'rechaza envelopes de desactivación incompatibles sin persistirlos: %j',
    async (override) => {
      vi.stubEnv('INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED', 'true');
      const changedAt = new Date().toISOString();
      await expect(
        service.process({
          message_id: randomUUID(),
          operation_id: randomUUID(),
          correlation_id: randomUUID(),
          schema_version: 1,
          occurred_at: changedAt,
          kind: 'event',
          producer: 'catalog-svc',
          name: 'catalog.sku.deactivated',
          data: {
            sku: 'SKU',
            product_id: randomUUID(),
            sku_version: 1,
            changed_at: changedAt,
          },
          ...override,
        }),
      ).rejects.toMatchObject({ reason: 'INVALID_MESSAGE' });
      expect(db.inbox).toHaveLength(0);
      expect(db.skuLifecycle).toHaveLength(0);
    },
  );
});
