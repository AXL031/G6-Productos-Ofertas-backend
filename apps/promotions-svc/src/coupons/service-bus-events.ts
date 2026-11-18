import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from '@azure/service-bus';
import { assignedH4Contracts } from './assigned-h4-contract.generated.js';
import { PromotionsAssignedEventDispatcher } from './assigned-event-dispatcher.js';
import { record } from './schema-validator.js';
import type { PromotionsServiceBusConfig } from './service-bus-config.js';

// Queue ownership and Sender RBAC must be verified before activation. The body
// producer/app properties alone never authenticate the producer.
export const promotionsEventRoutes = [
  {
    queue: 'g6.promotions.from.catalog',
    producer: 'catalog-svc',
    names: ['catalog.product.deactivated', 'catalog.sku.deactivated'],
  },
  {
    queue: 'g6.promotions.from.pricing',
    producer: 'pricing-svc',
    names: ['pricing.price.changed'],
  },
  {
    queue: 'g6.promotions.from.inventory',
    producer: 'inventory-svc',
    names: ['inventory.stock.changed'],
  },
] as const;
type Route = (typeof promotionsEventRoutes)[number];
export type EventReceiver = Pick<
  ServiceBusReceiver,
  | 'peekMessages'
  | 'subscribe'
  | 'completeMessage'
  | 'abandonMessage'
  | 'deadLetterMessage'
  | 'close'
>;
export interface EventBus {
  receiver(queue: string): EventReceiver;
  close(): Promise<void>;
}

export function nativePromotionsEventBus(
  config: PromotionsServiceBusConfig,
): EventBus {
  const credential = config.managedIdentityClientId
    ? new ManagedIdentityCredential({
        clientId: config.managedIdentityClientId,
      })
    : new DefaultAzureCredential();
  const client = new ServiceBusClient(config.namespace, credential);
  return {
    receiver: (queue) =>
      client.createReceiver(queue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
        maxAutoLockRenewalDurationInMs: 60_000,
      }),
    close: () => client.close(),
  };
}

export class PromotionsServiceBusEvents {
  private bus?: EventBus;
  private readonly receivers: EventReceiver[] = [];
  private readonly subscriptions: { close(): Promise<void> }[] = [];
  private readonly active = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private probe?: Promise<void>;
  private stopping = false;
  private available = false;

  constructor(
    private readonly config: PromotionsServiceBusConfig | undefined,
    private readonly dispatcher: Pick<
      PromotionsAssignedEventDispatcher,
      'assertReady' | 'process'
    >,
    private readonly open: (
      config: PromotionsServiceBusConfig,
    ) => EventBus = nativePromotionsEventBus,
  ) {}

  assertAvailable(): void {
    if (!this.available || this.stopping)
      throw new Error('PROMOTIONS_SERVICE_BUS_NOT_READY');
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config?.eventsEnabled || this.stopping) return;
    if (this.bus) throw new Error('PROMOTIONS_SERVICE_BUS_ALREADY_STARTED');
    this.dispatcher.assertReady();
    this.bus = this.open(this.config);
    const routes = this.config.eventQueues
      ? promotionsEventRoutes.filter((route) =>
          this.config?.eventQueues?.includes(route.queue),
        )
      : promotionsEventRoutes;
    try {
      for (const route of routes) {
        const receiver = this.bus.receiver(route.queue);
        this.receivers.push(receiver);
        await receiver.peekMessages(1, {
          abortSignal: AbortSignal.timeout(5000),
        });
      }
      for (const [index, route] of routes.entries()) {
        const receiver = this.receivers[index];
        this.subscriptions.push(
          receiver.subscribe(
            {
              processMessage: (message) => {
                const task = this.deliver(receiver, route, message);
                this.active.add(task);
                void task
                  .finally(() => this.active.delete(task))
                  .catch(() => undefined);
                return task;
              },
              processError: async () => {
                this.available = false;
              },
            },
            { autoCompleteMessages: false, maxConcurrentCalls: 1 },
          ),
        );
      }
      this.available = true;
      this.scheduleProbe();
    } catch {
      await this.onModuleDestroy();
      throw new Error('PROMOTIONS_SERVICE_BUS_START_FAILED');
    }
  }

  private scheduleProbe(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.probe = Promise.all(
        this.receivers.map((r) =>
          r.peekMessages(1, { abortSignal: AbortSignal.timeout(1000) }),
        ),
      )
        .then(() => {
          if (!this.stopping) this.available = true;
        })
        .catch(() => {
          this.available = false;
        })
        .finally(() => this.scheduleProbe());
    }, 5000);
    this.timer.unref();
  }

  private async deliver(
    receiver: EventReceiver,
    route: Route,
    message: ServiceBusReceivedMessage,
  ): Promise<void> {
    let body: Record<string, unknown>;
    let content: Buffer;
    try {
      if (
        message.contentType !== 'application/json' ||
        !(message.body instanceof Uint8Array)
      )
        throw new Error();
      content = Buffer.from(message.body);
      if (content.length > 65536) throw new Error();
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(content),
      );
      const metadata = message.applicationProperties ?? {};
      // AsyncAPI defines producer and version in the envelope. Some publishers
      // mirror these values as AMQP properties; a present mirror must agree.
      if (
        !record(value) ||
        typeof value.name !== 'string' ||
        !(route.names as readonly string[]).includes(value.name) ||
        value.producer !== route.producer ||
        value.kind !== 'event' ||
        message.subject !== value.name ||
        message.messageId !== value.message_id ||
        message.correlationId !== value.correlation_id ||
        (Object.hasOwn(metadata, 'producer') &&
          metadata.producer !== route.producer) ||
        (Object.hasOwn(metadata, 'schema_version') &&
          metadata.schema_version !== value.schema_version) ||
        (Object.hasOwn(metadata, 'route_version') &&
          metadata.route_version !== 1)
      )
        throw new Error();
      body = value;
    } catch {
      this.available = false;
      await receiver
        .deadLetterMessage(message, {
          deadLetterReason: 'INVALID_PROMOTIONS_EVENT',
          deadLetterErrorDescription: 'Contract or route validation failed',
        })
        .catch(() => undefined);
      return;
    }
    let rejected: boolean;
    try {
      const contract =
        assignedH4Contracts[body.name as keyof typeof assignedH4Contracts];
      const outcome = await this.dispatcher.process(
        {
          content,
          fields: {
            exchange: contract.exchange,
            routingKey: contract.routingKey,
          },
          properties: {
            contentType: 'application/json',
            messageId: String(message.messageId),
          },
        },
        route.producer,
      );
      rejected = outcome === 'rejected';
    } catch {
      this.available = false;
      await receiver.abandonMessage(message).catch(() => undefined);
      return;
    }
    // Settlement errors after commit are transport failures, never business rejection.
    try {
      if (rejected)
        await receiver.deadLetterMessage(message, {
          deadLetterReason: 'INVALID_PROMOTIONS_EVENT_DATA',
          deadLetterErrorDescription: 'Payload rejected durably',
        });
      else await receiver.completeMessage(message);
    } catch {
      this.available = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.available = false;
    clearTimeout(this.timer);
    await Promise.allSettled(this.subscriptions.map((s) => s.close()));
    await Promise.allSettled(this.active);
    await this.probe;
    await Promise.allSettled(this.receivers.map((r) => r.close()));
    await this.bus?.close();
  }
}
