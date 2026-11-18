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
  InventoryServiceBusConsumerRuntime,
  computeTransientBackoffMs,
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
  overrides?: Partial<InventoryDeliveryClaim['row']>,
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
      ...overrides,
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

  it('rechaza MESSAGING_PROVIDER desconocido', () => {
    expect(() =>
      readInventoryServiceBus({
        ...env,
        MESSAGING_PROVIDER: 'KAFKA',
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_CONFIGURATION_INVALID');

    expect(() =>
      readInventoryServiceBus({
        ...env,
        MESSAGING_PROVIDER: 'AWS_SNS',
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_CONFIGURATION_INVALID');
  });

  it('exige la presencia de ambos flags de publicación y consumo como valores literales true o false', () => {
    // Falta publishEnabled
    expect(() =>
      readInventoryServiceBus({
        ...env,
        INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: undefined,
        INVENTORY_SERVICE_BUS_CONSUME_ENABLED: 'true',
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');

    // Falta consumeEnabled
    expect(() =>
      readInventoryServiceBus({
        ...env,
        INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: 'true',
        INVENTORY_SERVICE_BUS_CONSUME_ENABLED: undefined,
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');

    // Valor no literal en publishEnabled (no acepta '1', 'yes', etc.)
    expect(() =>
      readInventoryServiceBus({
        ...env,
        INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: '1',
        INVENTORY_SERVICE_BUS_CONSUME_ENABLED: 'true',
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');

    // Valor no literal en consumeEnabled
    expect(() =>
      readInventoryServiceBus({
        ...env,
        INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: 'true',
        INVENTORY_SERVICE_BUS_CONSUME_ENABLED: '0',
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');
  });

  it('rechaza variables de H5 si MESSAGING_PROVIDER no es AZURE_SERVICE_BUS', () => {
    expect(() =>
      readInventoryServiceBus({
        MESSAGING_PROVIDER: 'RABBITMQ',
        INVENTORY_SERVICE_BUS_PUBLISH_ENABLED: 'true',
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');

    expect(() =>
      readInventoryServiceBus({
        INVENTORY_SERVICE_BUS_CONSUME_ENABLED: 'true',
      }),
    ).toThrow('INVENTORY_SERVICE_BUS_PILOT_CONFIGURATION_INVALID');
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

  it('rechaza y no publica si payload.message_id es ausente o no es UUID válido', async () => {
    // 1. message_id ausente
    const invalidClaim1 = outboxClaim();
    delete invalidClaim1.row.payload.message_id;
    const f1 = createFixture(true, invalidClaim1);
    expect(await f1.relay.publishOne()).toBe('terminal-failure');
    expect(f1.sender.sendMessages).not.toHaveBeenCalled();
    expect(f1.store.finish).toHaveBeenCalledWith(
      invalidClaim1,
      'terminal_invalid_envelope',
    );

    // 2. message_id no es UUID válido
    const invalidClaim2 = outboxClaim();
    invalidClaim2.row.payload.message_id = 'not-a-valid-uuid-1234';
    const f2 = createFixture(true, invalidClaim2);
    expect(await f2.relay.publishOne()).toBe('terminal-failure');
    expect(f2.sender.sendMessages).not.toHaveBeenCalled();
    expect(f2.store.finish).toHaveBeenCalledWith(
      invalidClaim2,
      'terminal_invalid_envelope',
    );

    // 3. message_id con espacios antes o después (rechazado por validación estricta sin trim)
    const invalidClaim3 = outboxClaim();
    invalidClaim3.row.payload.message_id = ` ${randomUUID()}`;
    const f3 = createFixture(true, invalidClaim3);
    expect(await f3.relay.publishOne()).toBe('terminal-failure');
    expect(f3.sender.sendMessages).not.toHaveBeenCalled();
    expect(f3.store.finish).toHaveBeenCalledWith(
      invalidClaim3,
      'terminal_invalid_envelope',
    );

    const invalidClaim4 = outboxClaim();
    invalidClaim4.row.payload.message_id = `${randomUUID()} `;
    const f4 = createFixture(true, invalidClaim4);
    expect(await f4.relay.publishOne()).toBe('terminal-failure');
    expect(f4.sender.sendMessages).not.toHaveBeenCalled();
    expect(f4.store.finish).toHaveBeenCalledWith(
      invalidClaim4,
      'terminal_invalid_envelope',
    );
  });

  it('rechaza y marca terminal si row.payload es una cadena no interpretable como envelope', async () => {
    const invalidClaim = outboxClaim();
    invalidClaim.row.payload = 'cadena-no-json-ni-envelope';
    const f = createFixture(true, invalidClaim);
    expect(await f.relay.publishOne()).toBe('terminal-failure');
    expect(f.sender.sendMessages).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      invalidClaim,
      'terminal_invalid_envelope',
    );
  });

  it('rechaza y no publica si payload.name no coincide con row.event_type', async () => {
    const invalidClaim = outboxClaim();
    invalidClaim.row.payload.name = 'otro.evento.discrepante';
    const f = createFixture(true, invalidClaim);
    expect(await f.relay.publishOne()).toBe('terminal-failure');
    expect(f.sender.sendMessages).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      invalidClaim,
      'terminal_invalid_envelope',
    );
  });

  it('rechaza y no publica si payload.producer no es inventory-svc', async () => {
    const invalidClaim = outboxClaim();
    invalidClaim.row.payload.producer = 'catalog-svc';
    const f = createFixture(true, invalidClaim);
    expect(await f.relay.publishOne()).toBe('terminal-failure');
    expect(f.sender.sendMessages).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      invalidClaim,
      'terminal_invalid_envelope',
    );
  });

  it('rechaza y no publica si el destino no corresponde a la ruta aprobada para ese evento', async () => {
    // inventory.sku.initialization.completed solo está aprobado para CATALOG, no para COMBOS
    const invalidClaim = outboxClaim(INVENTORY_QUEUES.COMBOS);
    const f = createFixture(true, invalidClaim);
    expect(await f.relay.publishOne()).toBe('terminal-failure');
    expect(f.sender.sendMessages).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(
      invalidClaim,
      'terminal_invalid_envelope',
    );
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
  let mockDelay: any;

  beforeEach(() => {
    settlement = {
      completeMessage: vi.fn(async () => undefined),
      abandonMessage: vi.fn(async () => undefined),
      deadLetterMessage: vi.fn(async () => undefined),
    };
    mockCommands = {
      process: vi.fn(async () => ({ duplicate: false, status: 'INITIALIZED' })),
    };
    mockDelay = vi.fn(async () => undefined);
    handler = new InventoryServiceBusHandler(
      mockCommands,
      settlement,
      mockDelay,
    );
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
      deliveryCount: 1,
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

  it('calcula retardo de backoff según deliveryCount (1s, 2s, 4s, 8s, hasta 16s)', () => {
    expect(computeTransientBackoffMs(1)).toBe(1000);
    expect(computeTransientBackoffMs(2)).toBe(2000);
    expect(computeTransientBackoffMs(3)).toBe(4000);
    expect(computeTransientBackoffMs(4)).toBe(8000);
    expect(computeTransientBackoffMs(5)).toBe(16000);
    expect(computeTransientBackoffMs(6)).toBe(16000);
    expect(computeTransientBackoffMs(10)).toBe(16000);
    expect(computeTransientBackoffMs(undefined)).toBe(1000);
  });

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

  it('rechaza correlación alterada y acepta la entrega binaria del SDK', async () => {
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    expect(await handler.handle({ ...msg, correlationId: randomUUID() })).toBe(
      'dead-lettered',
    );
    expect(mockCommands.process).not.toHaveBeenCalled();
    expect(
      await handler.handle({
        ...msg,
        body: Uint8Array.from(Buffer.from(String(msg.body))),
      }),
    ).toBe('completed');
    expect(mockCommands.process).toHaveBeenCalledOnce();
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

  it('rechaza con DLQ antes de llamar a command service si subject está ausente o no coincide', async () => {
    // 1. subject ausente
    const msgWithoutSubject = createReceivedMessage(
      'inventory.sku.initialization.requested',
    );
    delete (msgWithoutSubject as any).subject;
    const r1 = await handler.handle(msgWithoutSubject);
    expect(r1).toBe('dead-lettered');
    expect(mockCommands.process).not.toHaveBeenCalled();

    // 2. subject discrepante
    const msgMismatched = createReceivedMessage(
      'inventory.sku.initialization.requested',
    );
    (msgMismatched as any).subject = 'otro.evento.distinto';
    const r2 = await handler.handle(msgMismatched);
    expect(r2).toBe('dead-lettered');
    expect(mockCommands.process).not.toHaveBeenCalled();
  });

  it('rechaza con DLQ antes de llamar a command service si messageId o payload.message_id son inválidos o no coinciden', async () => {
    // 1. messageId del broker no es UUID
    const msg1 = createReceivedMessage(
      'inventory.sku.initialization.requested',
    );
    (msg1 as any).messageId = 'not-a-uuid';
    expect(await handler.handle(msg1)).toBe('dead-lettered');
    expect(mockCommands.process).not.toHaveBeenCalled();

    // 2. payload.message_id no es UUID
    const msg2 = createReceivedMessage(
      'inventory.sku.initialization.requested',
    );
    const parsed2 = JSON.parse(String(msg2.body));
    parsed2.message_id = 'not-a-uuid';
    (msg2 as any).body = JSON.stringify(parsed2);
    expect(await handler.handle(msg2)).toBe('dead-lettered');
    expect(mockCommands.process).not.toHaveBeenCalled();

    // 3. messageId y payload.message_id difieren
    const msg3 = createReceivedMessage(
      'inventory.sku.initialization.requested',
    );
    (msg3 as any).messageId = randomUUID();
    expect(await handler.handle(msg3)).toBe('dead-lettered');
    expect(mockCommands.process).not.toHaveBeenCalled();
  });

  it('rechaza con DLQ si producer no es catalog-svc', async () => {
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    const parsed = JSON.parse(String(msg.body));
    parsed.producer = 'promotions-svc';
    (msg as any).body = JSON.stringify(parsed);

    const result = await handler.handle(msg);
    expect(result).toBe('dead-lettered');
    expect(mockCommands.process).not.toHaveBeenCalled();
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
      subject: 'inventory.sku.initialization.requested',
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

  it('aplica retardo exponencial antes de abandonar el mensaje ante fallo transitorio (DB error)', async () => {
    mockCommands.process.mockRejectedValueOnce(
      new Error('PostgreSQL connection timeout'),
    );
    const msg = createReceivedMessage('inventory.sku.initialization.requested');
    (msg as any).deliveryCount = 3; // debe esperar 4000ms

    const result = await handler.handle(msg);
    expect(result).toBe('abandoned');
    expect(mockDelay).toHaveBeenCalledWith(4000);
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

describe('Inventory Service Bus Consumer Runtime — Ciclo de Vida y Reconexión', () => {
  it('cierra el receiver y no crea nueva suscripción si el cierre de la anterior falla', async () => {
    const runtime = new InventoryServiceBusConsumerRuntime({} as any);
    const mockSubscription = {
      close: vi
        .fn()
        .mockRejectedValue(new Error('Fallo al cerrar suscripción previa')),
    };
    const mockReceiver = {
      close: vi.fn().mockResolvedValue(undefined),
      peekMessages: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn(),
    };
    const mockClient = {
      createReceiver: vi.fn(() => mockReceiver),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (runtime as any).client = mockClient;
    (runtime as any).subscription = mockSubscription;
    (runtime as any).receiver = mockReceiver;

    // Intentar abrir cuando ya existía una suscripción cuyo cierre falla
    await (runtime as any).open();

    expect(mockSubscription.close).toHaveBeenCalledTimes(1);
    expect(mockReceiver.close).toHaveBeenCalledTimes(1);
    expect(mockReceiver.subscribe).not.toHaveBeenCalled();
    expect((runtime as any).subscription).toBeUndefined();
    expect((runtime as any).receiver).toBeUndefined();
    expect((runtime as any).available).toBe(false);

    await runtime.onModuleDestroy();
  });

  it('conserva referencias y no crea otro receiver ni suscripción si tanto subscription.close como receiver.close fallan', async () => {
    const runtime = new InventoryServiceBusConsumerRuntime({} as any);
    const mockSubscription = {
      close: vi
        .fn()
        .mockRejectedValue(new Error('Fallo al cerrar suscripción previa')),
    };
    const mockReceiver = {
      close: vi
        .fn()
        .mockRejectedValue(new Error('Fallo al cerrar receiver previo')),
      peekMessages: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn(),
    };
    const mockClient = {
      createReceiver: vi.fn(() => mockReceiver),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (runtime as any).client = mockClient;
    (runtime as any).subscription = mockSubscription;
    (runtime as any).receiver = mockReceiver;

    // Al fallar ambos métodos close(), debe conservar las referencias y reintentar con el temporizador único
    await (runtime as any).open();

    expect(mockSubscription.close).toHaveBeenCalledTimes(1);
    expect(mockReceiver.close).toHaveBeenCalledTimes(1);
    expect(mockClient.createReceiver).not.toHaveBeenCalled();
    expect(mockReceiver.subscribe).not.toHaveBeenCalled();
    // Referencias conservadas
    expect((runtime as any).subscription).toBe(mockSubscription);
    expect((runtime as any).receiver).toBe(mockReceiver);
    expect((runtime as any).available).toBe(false);
    expect((runtime as any).reconnectTimer).toBeDefined();

    await runtime.onModuleDestroy();
  });

  it('recupera y activa como máximo una suscripción cuando el cierre finalmente se confirma tras fallo inicial', async () => {
    const runtime = new InventoryServiceBusConsumerRuntime({} as any);
    const mockSubscription = {
      close: vi
        .fn()
        .mockRejectedValueOnce(new Error('Fallo temporal de suscripción'))
        .mockResolvedValueOnce(undefined),
    };
    const mockReceiver = {
      close: vi
        .fn()
        .mockRejectedValueOnce(new Error('Fallo temporal de receiver'))
        .mockResolvedValue(undefined),
      peekMessages: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn(),
    };
    const mockClient = {
      createReceiver: vi.fn(() => mockReceiver),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (runtime as any).client = mockClient;
    (runtime as any).subscription = mockSubscription;
    (runtime as any).receiver = mockReceiver;

    // Intento 1: fallan ambos close()
    await (runtime as any).open();
    expect((runtime as any).subscription).toBe(mockSubscription);
    expect((runtime as any).receiver).toBe(mockReceiver);
    expect(mockReceiver.subscribe).not.toHaveBeenCalled();
    expect((runtime as any).reconnectTimer).toBeDefined();

    // Simular el disparo del temporizador de reconexión
    clearTimeout((runtime as any).reconnectTimer);
    (runtime as any).reconnectTimer = undefined;

    // Intento 2: subscription.close() se recupera y confirma el cierre
    await (runtime as any).open();
    expect(mockSubscription.close).toHaveBeenCalledTimes(2);
    // Exactamente una suscripción activa
    expect(mockReceiver.subscribe).toHaveBeenCalledTimes(1);
    expect((runtime as any).available).toBe(true);

    await runtime.onModuleDestroy();
  });

  it('cancela temporizador y evita reconexiones tras onModuleDestroy', async () => {
    const runtime = new InventoryServiceBusConsumerRuntime({} as any);
    const mockReceiver = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockClient = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    (runtime as any).client = mockClient;
    (runtime as any).receiver = mockReceiver;
    (runtime as any).reconnectTimer = setTimeout(() => {}, 10000);

    await runtime.onModuleDestroy();

    expect((runtime as any).stopped).toBe(true);
    expect((runtime as any).reconnectTimer).toBeUndefined();
    expect(mockReceiver.close).toHaveBeenCalledTimes(1);
    expect(mockClient.close).toHaveBeenCalledTimes(1);

    // Un intento de open posterior no debe hacer nada porque stopped es true
    await (runtime as any).open();
    expect((runtime as any).isOpening).toBe(false);
  });
});
