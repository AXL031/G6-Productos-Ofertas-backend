import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import {
  assertCatalogPublication,
  InvalidCatalogMessage,
  parseCatalogMessage,
  type CatalogEnvelope,
} from './catalog-messages.js';
import type { CatalogMessageService } from './catalog-message.service.js';

export const catalogDestinations = {
  'pricing.product.initialization.requested': ['g6.pricing.from.catalog'],
  'inventory.sku.initialization.requested': ['g6.inventory.from.catalog'],
  'catalog.product.deactivated': [
    'g6.promotions.from.catalog',
    'g6.combos.from.catalog',
  ],
  'catalog.sku.deactivated': [
    'g6.inventory.from.catalog',
    'g6.pricing.from.catalog',
    'g6.promotions.from.catalog',
    'g6.combos.from.catalog',
  ],
  'catalog.master.deactivation.checked': ['g6.taxonomy.from.catalog'],
  'catalog.bulk.upsert.completed': ['g6.bulk.from.catalog'],
  'catalog.bulk.upsert.rejected': ['g6.bulk.from.catalog'],
} as const;

const producerByQueue = {
  'g6.catalog.from.taxonomy': 'taxonomy-svc',
  'g6.catalog.from.bulk': 'bulk-svc',
  'g6.catalog.from.pricing': 'pricing-svc',
  'g6.catalog.from.inventory': 'inventory-svc',
} as const;

type IncomingQueue = keyof typeof producerByQueue;

export function destinationsFor(message: CatalogEnvelope): readonly string[] {
  assertCatalogPublication(message);
  if (!Object.hasOwn(catalogDestinations, message.name))
    throw new InvalidCatalogMessage();
  return catalogDestinations[message.name as keyof typeof catalogDestinations];
}

export class CatalogServiceBus {
  private readonly senders = new Map<
    string,
    ReturnType<ServiceBusClient['createSender']>
  >();

  constructor(
    private readonly client: Pick<
      ServiceBusClient,
      'createSender' | 'createReceiver' | 'close'
    >,
  ) {}

  async publish(
    destination: string,
    envelope: CatalogEnvelope,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (!destinationsFor(envelope).includes(destination))
      throw new InvalidCatalogMessage();
    let sender = this.senders.get(destination);
    if (!sender) {
      sender = this.client.createSender(destination);
      this.senders.set(destination, sender);
    }
    const message = {
      body: Buffer.from(JSON.stringify(envelope)),
      contentType: 'application/json',
      messageId: envelope.message_id,
      correlationId: envelope.correlation_id,
      subject: envelope.name,
    };
    const batch = await sender.createMessageBatch({
      maxSizeInBytes: 256 * 1024,
      abortSignal,
    });
    if (!batch.tryAddMessage(message))
      throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
    await sender.sendMessages(batch, { abortSignal });
  }

  subscribe(
    queue: IncomingQueue,
    service: Pick<CatalogMessageService, 'consume'>,
    reportError: () => void,
  ) {
    if (!Object.hasOwn(producerByQueue, queue))
      throw new InvalidCatalogMessage();
    const receiver = this.client.createReceiver(queue, {
      receiveMode: 'peekLock',
    });
    const subscription = receiver.subscribe(
      {
        processMessage: async (received: ServiceBusReceivedMessage) => {
          try {
            if (
              received.contentType !== 'application/json' ||
              !Buffer.isBuffer(received.body)
            )
              throw new InvalidCatalogMessage();
            const envelope = parseCatalogMessage(
              JSON.parse(received.body.toString('utf8')),
            );
            if (
              envelope.producer !== producerByQueue[queue] ||
              received.messageId !== envelope.message_id ||
              received.correlationId !== envelope.correlation_id ||
              received.subject !== envelope.name
            )
              throw new InvalidCatalogMessage();
            await service.consume(envelope);
          } catch (error) {
            if (
              error instanceof InvalidCatalogMessage ||
              error instanceof SyntaxError
            ) {
              await receiver.deadLetterMessage(received, {
                deadLetterReason: 'INVALID_CATALOG_MESSAGE',
                deadLetterErrorDescription:
                  'Envelope or routing metadata failed validation.',
              });
            } else {
              reportError();
              await receiver.abandonMessage(received);
            }
            return;
          }
          // A failed settlement after commit is allowed to redeliver to the same Inbox.
          await receiver.completeMessage(received);
        },
        processError: async () => {
          reportError();
        },
      },
      { autoCompleteMessages: false },
    );
    return async () => {
      try {
        await subscription.close();
      } finally {
        await receiver.close();
      }
    };
  }

  close() {
    return this.client.close();
  }
}

/** Separate construction boundary for a dedicated H5 process or test harness. */
export function createCatalogServiceBus(
  env: NodeJS.ProcessEnv,
): CatalogServiceBus | undefined {
  const provider = env.MESSAGING_PROVIDER;
  if (!provider || provider === 'RABBITMQ') return undefined;
  if (provider !== 'AZURE_SERVICE_BUS' || env.CATALOG_AMQP_ENABLED === 'true')
    throw new Error(
      'Proveedor H5 inválido o RabbitMQ habilitado en el mismo proceso.',
    );
  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN;
  if (
    !namespace ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/i.test(namespace)
  )
    throw new Error('SERVICE_BUS_NAMESPACE_FQDN inválido.');
  return new CatalogServiceBus(
    new ServiceBusClient(namespace, new ManagedIdentityCredential()),
  );
}
