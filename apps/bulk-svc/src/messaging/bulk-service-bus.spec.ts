import { randomUUID } from 'node:crypto';
import type { ServiceBusReceivedMessage } from '@azure/service-bus';
import { CatalogBulkResultConsumer } from './catalog-bulk-result-consumer.js';
import { readBulkCatalogBus } from './bulk-service-bus.js';
import type { BulkPersistenceRepository } from '../persistence/bulk.repository.js';

describe('Bulk Catalog result on Service Bus', () => {
  const fixture = () => {
    const payload = {
      message_id: randomUUID(),
      schema_version: 1,
      occurred_at: '2026-11-18T15:00:00Z',
      correlation_id: randomUUID(),
      causation_id: randomUUID(),
      operation_id: randomUUID(),
      producer: 'catalog-svc',
      kind: 'result',
      name: 'catalog.bulk.upsert.rejected',
      data: {
        batch_id: randomUUID(),
        batch_operation_id: randomUUID(),
        code: 'VALIDACION',
        detail: 'Test result',
      },
    };
    const message = {
      body: Buffer.from(JSON.stringify(payload)),
      contentType: 'application/json',
      subject: payload.name,
      messageId: payload.message_id,
      correlationId: payload.correlation_id,
    } as ServiceBusReceivedMessage;
    const recordCatalogBulkResult = vi.fn(async () => undefined);
    const repository = {
      recordCatalogBulkResult,
    } as unknown as BulkPersistenceRepository;
    const consumer = new CatalogBulkResultConsumer(repository, null);
    const receiver = {
      completeMessage: vi.fn(async () => undefined),
      deadLetterMessage: vi.fn(async () => undefined),
      abandonMessage: vi.fn(async () => undefined),
    };
    return { payload, message, recordCatalogBulkResult, consumer, receiver };
  };

  it('settles an assigned result only after the existing result handler commits', async () => {
    const f = fixture();
    let committed = () => {};
    f.recordCatalogBulkResult.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          committed = resolve;
        }),
    );
    const task = f.consumer.handleAzure(f.message, f.receiver);
    expect(f.recordCatalogBulkResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: f.payload.message_id,
        causationId: f.payload.causation_id,
        operationId: f.payload.operation_id,
      }),
    );
    expect(f.receiver.completeMessage).not.toHaveBeenCalled();
    committed();
    await task;
    expect(f.receiver.completeMessage).toHaveBeenCalledWith(f.message);
  });

  it('dead-letters different correlation IDs and abandons a failure before commit', async () => {
    const f = fixture();
    await f.consumer.handleAzure(
      { ...f.message, correlationId: randomUUID() },
      f.receiver,
    );
    expect(f.recordCatalogBulkResult).not.toHaveBeenCalled();
    expect(f.receiver.deadLetterMessage).toHaveBeenCalledOnce();
    f.recordCatalogBulkResult.mockRejectedValueOnce(
      new Error('DATABASE_UNAVAILABLE'),
    );
    await f.consumer.handleAzure(f.message, f.receiver);
    expect(f.receiver.abandonMessage).toHaveBeenCalledWith(f.message);
    expect(f.receiver.completeMessage).not.toHaveBeenCalled();
  });

  it('requires an exclusive transport and a workload identity for production', () => {
    const env = {
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      BULK_SERVICE_BUS_CATALOG_RESULTS_ENABLED: 'true',
      SERVICE_BUS_NAMESPACE_FQDN: 'test-h5.servicebus.windows.net',
    };
    expect(readBulkCatalogBus(env)?.enabled).toBe(true);
    expect(() =>
      readBulkCatalogBus({ ...env, BULK_AMQP_ENABLED: 'true' }),
    ).toThrow();
    expect(() =>
      readBulkCatalogBus({ ...env, NODE_ENV: 'production' }),
    ).toThrow();
  });
});
