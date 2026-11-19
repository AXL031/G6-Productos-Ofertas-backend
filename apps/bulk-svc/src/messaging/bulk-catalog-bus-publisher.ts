import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BulkPersistenceRepository } from '../persistence/bulk.repository.js';
import { catalogFromBulk, readBulkCatalogBus } from './bulk-service-bus.js';

@Injectable()
export class BulkCatalogBusPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BulkCatalogBusPublisher.name);
  private client?: ServiceBusClient;
  private sender?: ServiceBusSender;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(private readonly repository: BulkPersistenceRepository) {}

  onModuleInit() {
    const config = readBulkCatalogBus(process.env);
    if (!config?.send) return;
    this.client = new ServiceBusClient(
      config.namespace,
      config.clientId
        ? new ManagedIdentityCredential({ clientId: config.clientId })
        : new DefaultAzureCredential(),
      { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
    );
    const sender = this.client.createSender(catalogFromBulk);
    this.sender = sender;
    const tick = () => {
      this.inFlight ??= this.flush(sender)
        .catch(() =>
          this.logger.warn('BULK_CATALOG_SERVICE_BUS_PUBLISH_FAILED'),
        )
        .finally(() => {
          this.inFlight = undefined;
        });
    };
    this.timer = setInterval(tick, 2000);
    this.timer.unref();
    tick();
  }

  async flush(
    sender: Pick<ServiceBusSender, 'createMessageBatch' | 'sendMessages'>,
  ) {
    for (const entry of await this.repository.findPendingOutbox(
      50,
      true,
      'CATALOG_SERVICE_BUS',
    )) {
      const options = { abortSignal: AbortSignal.timeout(5000) };
      const batch = await sender.createMessageBatch(options);
      if (
        !batch.tryAddMessage({
          body: Buffer.from(JSON.stringify(entry.payload), 'utf8'),
          messageId: entry.messageId,
          correlationId: entry.correlationId,
          subject: entry.eventName,
          contentType: 'application/json',
        })
      )
        throw new Error('BULK_CATALOG_SERVICE_BUS_ENVELOPE_TOO_LARGE');
      await sender.sendMessages(batch, options);
      await this.repository.deferOutboxUntilCatalogResult(
        entry.messageId,
        entry.attempts + 1,
      );
    }
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    try {
      await this.sender?.close();
      await this.inFlight;
    } finally {
      await this.client?.close();
    }
  }
}
