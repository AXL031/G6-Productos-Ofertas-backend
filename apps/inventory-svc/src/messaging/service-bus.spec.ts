import { describe, expect, it, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  ServiceBusMessage,
  ServiceBusMessageBatch,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { readInventoryServiceBus } from './service-bus-config.js';
import { InventoryServiceBusRelay } from './service-bus-relay.js';
import {
  InventoryServiceBusHandler,
  type InventoryBusSettlement,
} from './service-bus-consumer.js';
import {
  INVENTORY_QUEUES,
  insertInventoryDeliveries,
  type InventoryDeliveryClaim,
} from './service-bus-deliveries.js';
import { InventoryMessageError } from '../inbox/inventory-command.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { DatabaseService } from '../database/database.service.js';

const env = {
  NODE_ENV: 'test',
  MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
  G6_SERVICE_BUS_PILOT_ENABLED: 'true',
  INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: 'true',
  INVENTORY_SERVICE_BUS_CONSUME_ENABLED: 'true',
  SERVICE_BUS_NAMESPACE_FQDN: 'g6-pilot-inventory.servicebus.windows.net',
};

function outboxClaim(
  destination = INVENTORY_QUEUES.CATALOG,
): InventoryDeliveryClaim {
  const eventId = randomUUID();
  const canonicalMessageId = randomUUID();
  return {
    token: randomUUID(),
    destination,
    row: {
      id: randomUUID(),
      event_id: eventId,
      event_type: 'inventory.sku.initialization.completed',
      aggregate_type: 'stock',
      aggregate_id: 'SKU-TEST-001',
      correlation_id: randomUUID(),
      payload: {
        message_id: canonicalMessageId,
        schema_version: 2,
        kind: 'result',
        name: 'inventory.sku.initialization.completed',
        producer: 'inventory-svc',
        operation_id: randomUUID(),
        correlation_id: randomUUID(),
        data: {
          sku: 'SKU-TEST-001',
          product_id: randomUUID(),
          variant_id: null,
          status: 'INITIALIZED',
          code: null,
          completed_at: new Date().toISOString(),
        },
      },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    },
  };
}

describe('Inventory Service Bus — Configuración y Seguridad (H5)', () => {
  it('mantiene H4 inalterado a menos que el piloto se active explícitamente', () => {
    expect(readInventoryServiceBus({})).toBeUndefined();
    expect(
      readInventoryServiceBus({ MESSAGING_PROVIDER: 'RABBITMQ' }),
    ).toBeUndefined();
    expect(readInventoryServiceBus(env)).toEqual({
      namespace: env.SERVICE_BUS_NAMESPACE_FQDN,
      publishEnabled: true,
      consumeEnabled: true,
    });
  });

  it('permite controlar independientemente publicación y consumo', () => {
    const onlyPub = readInventoryServiceBus({
      ...env,
      INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: 'true',
      INVENTORY_SERVICE_BUS_CONSUME_ENABLED: 'false',
    });
    expect(onlyPub?.publishEnabled).toBe(true);
    expect(onlyPub?.consumeEnabled).toBe(false);

    const onlySub = readInventoryServiceBus({
      ...env,
      INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: 'false',
      INVENTORY_SERVICE_BUS_CONSUME_ENABLED: 'true',
    });
    expect(onlySub?.publishEnabled).toBe(false);
    expect(onlySub?.consumeEnabled).toBe(true);
  });

  it('permite producción únicamente con activación explícita, G7 e identidad asignada', () => {
    const clientId = randomUUID();
    const production = {
      ...env,
      NODE_ENV: 'production',
      G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AZURE_CLIENT_ID: clientId,
    };
    expect(readInventoryServiceBus(production)).toEqual({
      namespace: env.SERVICE_BUS_NAMESPACE_FQDN,
      publishEnabled: true,
      consumeEnabled: true,
      managedIdentityClientId: clientId,
    });

    for (const change of [
      { G6_SERVICE_BUS_PRODUCTION_ENABLED: undefined },
      { G6_SECURITY_MODE: 'SIMULATED_AUTH' },
      { G6_SECURITY_MODE: 'PUBLIC_READ_ONLY' },
      { AZURE_CLIENT_ID: undefined },
      { AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000' },
      { AZURE_CLIENT_ID: 'invalid' },
      { NODE_ENV: 'development' },
    ]) {
      expect(() =>
        readInventoryServiceBus({ ...production, ...change }),
      ).toThrow();
    }
  });

  it.each([
    { NODE_ENV: 'production' },
    { RABBITMQ_URL: 'amqps://private' },
    { G6_SERVICE_BUS_PILOT_ENABLED: 'false' },
    { INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: 'invalid' },
    { INVENTORY_SERVICE_BUS_CONSUME_ENABLED: 'invalid' },
    {
      SERVICE_BUS_NAMESPACE_FQDN:
        'https://g6-pilot-inventory.servicebus.windows.net',
    },
    {
      SERVICE_BUS_NAMESPACE_FQDN:
        'g6-pilot-inventory.servicebus.windows.net.attacker.invalid',
    },
  ])('rechaza producción, transporte mixto o FQDN inválido: %j', (change) => {
    expect(() => readInventoryServiceBus({ ...env, ...change })).toThrow();
  });
});

describe('Inventory Service Bus Relay — Publicación Outbox y Confirmación', () => {
  function createFixture(canAdd = true, claimObj = outboxClaim()) {
    const added: ServiceBusMessage[] = [];
    const batch: ServiceBusMessageBatch = {
      count: 1,
      sizeInBytes: 500,
      maxSizeInBytes: 256 * 1024,
      tryAddMessage: (message) => {
        if (canAdd) added.push(message as ServiceBusMessage);
        return canAdd;
      },
      _generateMessage: () => Buffer.alloc(0),
      _messageSpanContexts: [],
    };
    const store = {
      claim: vi.fn(async () => claimObj),
      finish: vi.fn(async () => true),
    };
    const sender = {
      createMessageBatch: vi.fn(async () => batch),
      sendMessages: vi.fn(async () => undefined),
    };
    const senders = new Map([
      [INVENTORY_QUEUES.CATALOG, sender],
      [INVENTORY_QUEUES.COMBOS, sender],
      [INVENTORY_QUEUES.PROMOTIONS, sender],
    ]);
    return {
      claimObj,
      added,
      store,
      sender,
      relay: new InventoryServiceBusRelay(store, senders),
    };
  }

  it('utiliza payload.message_id como identificador canónico en messageId del broker', async () => {
    const f = createFixture();
    expect(await f.relay.publishOne()).toBe('sent');
    expect(f.sender.createMessageBatch).toHaveBeenCalledWith({
      maxSizeInBytes: 256 * 1024,
    });
    // El messageId enviado al broker debe ser exactamente payload.message_id
    expect(f.added[0].messageId).toBe(f.claimObj.row.payload.message_id);
    expect(f.added[0].subject).toBe(f.claimObj.row.event_type);
    expect(Buffer.isBuffer(f.added[0].body)).toBe(true);

    const parsedBody = JSON.parse(String(f.added[0].body));
    expect(parsedBody).toMatchObject({
      name: 'inventory.sku.initialization.completed',
      producer: 'inventory-svc',
    });
    expect(f.store.finish).toHaveBeenCalledWith(f.claimObj, 'confirmed');
  });

  it('conserva el mensaje PENDING con el mismo message_id ante timeout o error de broker', async () => {
    const f = createFixture();
    f.sender.sendMessages.mockRejectedValueOnce(
      new Error('Timeout de broker Service Bus'),
    );
    expect(await f.relay.publishOne()).toBe('pending');
    expect(f.store.finish).toHaveBeenCalledWith(f.claimObj, 'failed');

    // Segundo intento exitoso con el mismo payload.message_id canónico
    expect(await f.relay.publishOne()).toBe('sent');
    expect(f.added.map((m) => m.messageId)).toEqual([
      f.claimObj.row.payload.message_id,
      f.claimObj.row.payload.message_id,
    ]);
  });

  it('registra fallo terminal recuperable si el mensaje excede los 256 KB sin reintentos infinitos', async () => {
    const f = createFixture(false);
    expect(await f.relay.publishOne()).toBe('terminal-failure');
    expect(f.sender.sendMessages).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      f.claimObj,
      'terminal_too_large',
    );
  });

  it('informa lease-lost si otro proceso ganó el lock de la entrega', async () => {
    const f = createFixture();
    f.store.finish.mockResolvedValueOnce(false);
    expect(await f.relay.publishOne()).toBe('lease-lost');
  });

  it('retorna empty si no hay entregas pendientes', async () => {
    const f = createFixture();
    f.store.claim.mockResolvedValueOnce(undefined);
    expect(await f.relay.publishOne()).toBe('empty');
  });
});

describe('Inventory Service Bus Consumer — Recepción en PeekLock e Idempotencia', () => {
  let settlement: InventoryBusSettlement;
  let mockCommands: any;
  let handler: InventoryServiceBusHandler;

  beforeEach(() => {
    settlement = {
      completeMessage: vi.fn(async () => undefined),
      abandonMessage: vi.fn(async () => undefined),
      deadLetterMessage: vi.fn(async () => undefined),
    };
    mockCommands = {
      process: vi.fn(async () => ({ duplicate: false, status: 'INITIALIZED' })),
    };
    handler = new InventoryServiceBusHandler(mockCommands, settlement);
  });

  function createReceivedMessage(
    name: string,
    data: Record<string, unknown> = {},
  ): ServiceBusReceivedMessage {
    const messageId = randomUUID();
    const correlationId = randomUUID();
    return {
      messageId,
      correlationId,
      contentType: 'application/json',
      subject: name,
      body: JSON.stringify({
        message_id: messageId,
        operation_id: randomUUID(),
        correlation_id: correlationId,
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'catalog-svc',
        name,
        kind: name.includes('requested') ? 'command' : 'event',
        data,
      }),
    } as unknown as ServiceBusReceivedMessage;
  }

  it('procesa inventory.sku.initialization.requested y completa el mensaje', async () => {
    const msg = createReceivedMessage(
      'inventory.sku.initialization.requested',
      {
        sku: 'SKU-001',
        product_id: randomUUID(),
      },
    );
    const result = await handler.handle(msg);
    expect(result).toBe('completed');
    expect(mockCommands.process).toHaveBeenCalledTimes(1);
    expect(settlement.completeMessage).toHaveBeenCalledWith(msg);
    expect(settlement.abandonMessage).not.toHaveBeenCalled();
    expect(settlement.deadLetterMessage).not.toHaveBeenCalled();
  });

  it('procesa catalog.sku.deactivated y completa el mensaje', async () => {
    const msg = createReceivedMessage('catalog.sku.deactivated', {
      sku: 'SKU-001',
      product_id: randomUUID(),
      sku_version: 1,
      changed_at: new Date().toISOString(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe('completed');
    expect(mockCommands.process).toHaveBeenCalledTimes(1);
    expect(settlement.completeMessage).toHaveBeenCalledWith(msg);
  });

  it('rechaza con DLQ si el subject no coincide con el payload.name', async () => {
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    (msg as any).subject = 'otro.evento.distinto';
    const result = await handler.handle(msg);
    expect(result).toBe('dead-lettered');
    expect(settlement.deadLetterMessage).toHaveBeenCalledWith(
      msg,
      expect.objectContaining({
        deadLetterReason: 'INVALID_INVENTORY_CONTRACT',
      }),
    );
  });

  it('rechaza con DLQ si el messageId no coincide con payload.message_id', async () => {
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    (msg as any).messageId = randomUUID(); // distinto a payload.message_id
    const result = await handler.handle(msg);
    expect(result).toBe('dead-lettered');
    expect(settlement.deadLetterMessage).toHaveBeenCalledWith(
      msg,
      expect.objectContaining({
        deadLetterReason: 'INVALID_INVENTORY_CONTRACT',
      }),
    );
  });

  it('bloquea por contrato inventory.bulk.stock.adjust.requested y lo envía a DLQ con BLOCKED_CONTRACT', async () => {
    const msg = createReceivedMessage('inventory.bulk.stock.adjust.requested', {
      items: [],
    });
    const result = await handler.handle(msg);
    expect(result).toBe('dead-lettered');
    expect(mockCommands.process).not.toHaveBeenCalled();
    expect(settlement.deadLetterMessage).toHaveBeenCalledWith(
      msg,
      expect.objectContaining({
        deadLetterReason: 'BLOCKED_CONTRACT',
      }),
    );
    expect(settlement.completeMessage).not.toHaveBeenCalled();
  });

  it('envía a DLQ sin bucle de reintentos cuando ocurre FEATURE_DISABLED', async () => {
    mockCommands.process.mockRejectedValueOnce(
      new InventoryMessageError('FEATURE_DISABLED'),
    );
    const msg = createReceivedMessage('catalog.sku.deactivated');
    const result = await handler.handle(msg);
    expect(result).toBe('dead-lettered');
    expect(settlement.deadLetterMessage).toHaveBeenCalledWith(
      msg,
      expect.objectContaining({
        deadLetterReason: 'FEATURE_DISABLED',
      }),
    );
    expect(settlement.abandonMessage).not.toHaveBeenCalled();
  });

  it('envía a DLQ si el mensaje tiene payload corrupto o no es JSON válido', async () => {
    const msg = {
      messageId: randomUUID(),
      body: 'INVALID JSON NOT OBJECT {{{',
    } as unknown as ServiceBusReceivedMessage;
    const result = await handler.handle(msg);
    expect(result).toBe('dead-lettered');
    expect(settlement.deadLetterMessage).toHaveBeenCalledWith(
      msg,
      expect.objectContaining({
        deadLetterReason: 'INVALID_INVENTORY_CONTRACT',
      }),
    );
  });

  it('envía a DLQ si el comando lanza InventoryMessageError con INVALID_MESSAGE', async () => {
    mockCommands.process.mockRejectedValueOnce(
      new InventoryMessageError('INVALID_MESSAGE'),
    );
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    const result = await handler.handle(msg);
    expect(result).toBe('dead-lettered');
    expect(settlement.deadLetterMessage).toHaveBeenCalledWith(
      msg,
      expect.objectContaining({
        deadLetterReason: 'INVALID_MESSAGE',
      }),
    );
  });

  it('abandona el mensaje ante fallo transitorio (DB error) para reintento con backoff', async () => {
    mockCommands.process.mockRejectedValueOnce(
      new Error('PostgreSQL connection timeout'),
    );
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    const result = await handler.handle(msg);
    expect(result).toBe('abandoned');
    expect(settlement.abandonMessage).toHaveBeenCalledWith(msg);
    expect(settlement.completeMessage).not.toHaveBeenCalled();
    expect(settlement.deadLetterMessage).not.toHaveBeenCalled();
  });

  it('completa el mensaje correctamente ante entrega duplicada (idempotencia)', async () => {
    mockCommands.process.mockResolvedValueOnce({
      duplicate: true,
      status: 'INITIALIZED',
    });
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    const result = await handler.handle(msg);
    expect(result).toBe('completed');
    expect(settlement.completeMessage).toHaveBeenCalledWith(msg);
  });
});

describe('Inventory Outbox Deliveries — Transaccionalidad y Rollback', () => {
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
  });

  it('inserta entregas en outbox_delivery dentro de la misma transacción cuando H5 está seleccionado', async () => {
    const prevProvider = process.env.MESSAGING_PROVIDER;
    process.env.MESSAGING_PROVIDER = 'AZURE_SERVICE_BUS';
    try {
      const eventId = randomUUID();
      await dbService.transaction(async (tx) => {
        await insertInventoryDeliveries(tx, {
          event_id: eventId,
          event_type: 'inventory.stock.changed',
        });
      });

      // Debe insertar 2 entregas: Combos y Promotions
      expect(mockDb.outboxDeliveries.length).toBe(2);
      expect(mockDb.outboxDeliveries.map((d) => d.destination).sort()).toEqual(
        [INVENTORY_QUEUES.COMBOS, INVENTORY_QUEUES.PROMOTIONS].sort(),
      );
    } finally {
      process.env.MESSAGING_PROVIDER = prevProvider;
    }
  });

  it('hace rollback completo de outbox_delivery si la transacción de negocio falla', async () => {
    const prevProvider = process.env.MESSAGING_PROVIDER;
    process.env.MESSAGING_PROVIDER = 'AZURE_SERVICE_BUS';
    try {
      const eventId = randomUUID();
      await expect(
        dbService.transaction(async (tx) => {
          await insertInventoryDeliveries(tx, {
            event_id: eventId,
            event_type: 'inventory.stock.changed',
          });
          throw new Error('Fallo simulado en la transacción de negocio');
        }),
      ).rejects.toThrow('Fallo simulado en la transacción de negocio');

      // Las entregas no deben persistirse si hubo rollback
      expect(mockDb.outboxDeliveries.length).toBe(0);
    } finally {
      process.env.MESSAGING_PROVIDER = prevProvider;
    }
  });
});
