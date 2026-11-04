import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OutboxPublisherService,
  IMessageBrokerPublisher,
} from './outbox-publisher.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';

describe('OutboxPublisherService — Publicación Confiable y Confirmación de Broker', () => {
  let publisherService: OutboxPublisherService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;
  let outboxRepo: DrizzleOutboxRepository;
  afterEach(() => vi.useRealTimers());

  it('un confirm que nunca llega vence, conserva PENDING y reintenta con el mismo message_id', async () => {
    vi.useFakeTimers();
    const eventId = randomUUID();
    mockDb.outbox.push({
      id: 'timeout',
      event_id: eventId,
      event_type: 'inventory.stock.changed',
      aggregate_type: 'stock',
      aggregate_id: 'SKU',
      payload: { message_id: eventId, kind: 'event' },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });
    const publish = vi
      .fn<IMessageBrokerPublisher['publish']>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue(true);
    publisherService.setCustomPublisher({ publish });
    const dispatching = publisherService.dispatchPending();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await dispatching).toMatchObject({ dispatched: 0, failed: 1 });
    expect(mockDb.outbox[0].status).toBe('PENDING');
    expect(await publisherService.dispatchPending()).toMatchObject({
      dispatched: 1,
      failed: 0,
    });
    expect(mockDb.outbox[0].status).toBe('PUBLISHED');
    expect(publish).toHaveBeenCalledTimes(2);
    for (const call of publish.mock.calls)
      expect(call[3]).toMatchObject({
        messageId: eventId,
        mandatory: true,
        persistent: true,
      });
  });

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    outboxRepo = new DrizzleOutboxRepository(dbService);
    publisherService = new OutboxPublisherService(dbService, outboxRepo);
  });

  it('1. Debe despachar eventos PENDING al broker y marcarlos como PUBLISHED con confirmación', async () => {
    const eventId = randomUUID();
    const opId = randomUUID();

    mockDb.outbox.push({
      id: 'outbox-test-1',
      event_id: eventId,
      event_type: 'inventory.reservation.created',
      aggregate_type: 'reservation',
      aggregate_id: opId,
      payload: {
        message_id: eventId,
        schema_version: 2,
        kind: 'event',
        name: 'inventory.reservation.created',
        operation_id: opId,
        data: { test: true },
      },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    const publishedMessages: any[] = [];
    const mockPublisher: IMessageBrokerPublisher = {
      publish: async (exchange, routingKey, content) => {
        publishedMessages.push({
          exchange,
          routingKey,
          payload: JSON.parse(content.toString()),
        });
        return true; // Confirmed
      },
    };

    publisherService.setCustomPublisher(mockPublisher);

    const result = await publisherService.dispatchPending();

    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].exchange).toBe('po.eventos.x');
    expect(publishedMessages[0].routingKey).toBe(
      'inventory.reservation.created',
    );

    const updatedRow = mockDb.outbox.find((o) => o.id === 'outbox-test-1')!;
    expect(updatedRow.status).toBe('PUBLISHED');
    expect(updatedRow.published_at).toBeDefined();
  });

  it('2. Caso obligatorio: broker caído debe aislarse sin alterar el estado PENDING de outbox', async () => {
    const eventId = randomUUID();
    mockDb.outbox.push({
      id: 'outbox-test-fail',
      event_id: eventId,
      event_type: 'inventory.reservation.rejected',
      aggregate_type: 'reservation',
      aggregate_id: randomUUID(),
      payload: {
        message_id: eventId,
        schema_version: 2,
        kind: 'result',
        name: 'inventory.reservation.rejected',
        data: { test: true },
      },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    // Simulador de broker caído
    const failingPublisher: IMessageBrokerPublisher = {
      publish: async () => {
        throw new Error('Connection refused by RabbitMQ broker (ECONNREFUSED)');
      },
    };

    publisherService.setCustomPublisher(failingPublisher);

    const result = await publisherService.dispatchPending();

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);

    // El evento debe conservarse PENDING para posterior reintento durable
    const unpostedRow = mockDb.outbox.find((o) => o.id === 'outbox-test-fail')!;
    expect(unpostedRow.status).toBe('PENDING');
    expect(unpostedRow.published_at).toBeUndefined();
  });

  it('3. Caso obligatorio: mensaje devuelto (basic.return / NO ROUTE) debe tratarse como fallo de ruta y conservarse PENDING', async () => {
    const eventId = randomUUID();
    mockDb.outbox.push({
      id: 'outbox-unroutable',
      event_id: eventId,
      event_type: 'inventory.unroutable.event',
      aggregate_type: 'reservation',
      aggregate_id: randomUUID(),
      payload: {
        message_id: eventId,
        schema_version: 2,
        kind: 'event',
        name: 'inventory.unroutable.event',
        data: { test: true },
      },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    // Simulador de mensaje devuelto por no tener cola vinculada
    const returningPublisher: IMessageBrokerPublisher = {
      publish: async () => {
        throw new Error(
          'Mensaje devuelto por el broker: sin cola enlazada para exchange y routingKey (basic.return)',
        );
      },
    };

    publisherService.setCustomPublisher(returningPublisher);

    const result = await publisherService.dispatchPending();

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);

    const unroutedRow = mockDb.outbox.find(
      (o) => o.id === 'outbox-unroutable',
    )!;
    expect(unroutedRow.status).toBe('PENDING');
    expect(unroutedRow.published_at).toBeUndefined();
  });

  it('4. Caso obligatorio: dos dispatchers concurrentes no deben procesar ni duplicar los mismos registros', async () => {
    const event1 = randomUUID();
    const event2 = randomUUID();

    mockDb.outbox.push(
      {
        id: 'outbox-c1',
        event_id: event1,
        event_type: 'inventory.reservation.created',
        aggregate_type: 'reservation',
        aggregate_id: randomUUID(),
        payload: {
          message_id: event1,
          schema_version: 2,
          kind: 'event',
          name: 'inventory.reservation.created',
          data: { test: 1 },
        },
        status: 'PENDING',
        created_at: new Date(Date.now() - 2000).toISOString(),
      },
      {
        id: 'outbox-c2',
        event_id: event2,
        event_type: 'inventory.reservation.created',
        aggregate_type: 'reservation',
        aggregate_id: randomUUID(),
        payload: {
          message_id: event2,
          schema_version: 2,
          kind: 'event',
          name: 'inventory.reservation.created',
          data: { test: 2 },
        },
        status: 'PENDING',
        created_at: new Date(Date.now() - 1000).toISOString(),
      },
    );

    const publishedIds: string[] = [];
    const mockPublisher: IMessageBrokerPublisher = {
      publish: async (_exchange, _routingKey, content) => {
        const parsed = JSON.parse(content.toString());
        publishedIds.push(parsed.message_id);
        return true;
      },
    };

    const dispatcher1 = new OutboxPublisherService(dbService, outboxRepo);
    const dispatcher2 = new OutboxPublisherService(dbService, outboxRepo);
    dispatcher1.setCustomPublisher(mockPublisher);
    dispatcher2.setCustomPublisher(mockPublisher);

    // Ejecutar ambos dispatchers
    const [res1, res2] = await Promise.all([
      dispatcher1.dispatchPending(1),
      dispatcher2.dispatchPending(1),
    ]);

    // Ambos procesaron con éxito sin solaparse
    expect(res1.dispatched + res2.dispatched).toBe(2);
    expect(new Set(publishedIds).size).toBe(2);

    const allPublished = mockDb.outbox.every((o) => o.status === 'PUBLISHED');
    expect(allPublished).toBe(true);
  });

  it('5. Caso obligatorio: fallo posterior a la confirmación debe conservar la integridad transaccional', async () => {
    const eventId = randomUUID();
    mockDb.outbox.push({
      id: 'outbox-fail-after-confirm',
      event_id: eventId,
      event_type: 'inventory.reservation.created',
      aggregate_type: 'reservation',
      aggregate_id: randomUUID(),
      payload: {
        message_id: eventId,
        schema_version: 2,
        kind: 'event',
        name: 'inventory.reservation.created',
        data: { test: true },
      },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    // Simulador donde el broker confirma pero la persistencia local falla
    const mockPublisher: IMessageBrokerPublisher = {
      publish: async () => {
        return true; // Confirmed by broker
      },
    };

    publisherService.setCustomPublisher(mockPublisher);

    // Simular fallo en markAsPublished
    const failingRepo = {
      ...outboxRepo,
      findPendingForUpdateSkipLocked: (client: any, limit: number) =>
        outboxRepo.findPendingForUpdateSkipLocked(client, limit),
      markAsPublished: async () => {
        throw new Error('Database disk error during markAsPublished');
      },
    };

    const serviceWithFailingRepo = new OutboxPublisherService(
      dbService,
      failingRepo as any,
    );
    serviceWithFailingRepo.setCustomPublisher(mockPublisher);

    const result = await serviceWithFailingRepo.dispatchPending();
    expect(result.failed).toBe(1);
    expect(result.dispatched).toBe(0);

    const row = mockDb.outbox.find(
      (o) => o.id === 'outbox-fail-after-confirm',
    )!;
    expect(row.status).toBe('PENDING');
  });
});
