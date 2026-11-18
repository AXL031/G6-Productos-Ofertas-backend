import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import {
  PricingDeliveryStore,
  AUDIT_PILOT_QUEUE,
  PROMOTIONS_PRICE_QUEUE,
  type PricingPriceChangedQueue,
} from './service-bus-deliveries.js';
import { pricingEnvelope } from './outbox-relay.js';

export class PricingServiceBusRelay {
  constructor(
    private readonly store: Pick<PricingDeliveryStore, 'claim' | 'finish'>,
    private readonly sender: Pick<
      ServiceBusSender,
      'createMessageBatch' | 'sendMessages'
    >,
    private readonly destination: PricingPriceChangedQueue = AUDIT_PILOT_QUEUE,
  ) {}

  async publishOne(): Promise<'empty' | 'sent' | 'pending' | 'lease-lost'> {
    const claim = await this.store.claim();
    if (!claim) return 'empty';
    let confirmed = false;
    try {
      if (claim.destination !== this.destination)
        throw new Error('SERVICE_BUS_PILOT_ROUTE_NOT_APPROVED');
      // The SDK JSON-serializes non-binary bodies. Send canonical UTF-8 bytes
      // to avoid wrapping the envelope in a second JSON string.
      const body = pricingEnvelope(claim.row);
      // tryAddMessage accounts for AMQP properties/encoding, not only JSON bytes.
      const batch = await this.sender.createMessageBatch({
        maxSizeInBytes: 256 * 1024,
      });
      if (
        !batch.tryAddMessage({
          body,
          messageId: claim.row.messageId,
          correlationId: claim.row.correlationId,
          subject: 'pricing.price.changed',
          contentType: 'application/json',
          applicationProperties: {
            producer: 'pricing-svc',
            schema_version: 1,
            route_version: 1,
          },
        })
      )
        throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
      await this.sender.sendMessages(batch, {
        abortSignal: AbortSignal.timeout(10_000),
      });
      confirmed = true;
    } catch {
      // A timeout can occur after the broker accepted the batch; retain its ID.
    }
    const updated = await this.store.finish(claim, confirmed);
    return !updated ? 'lease-lost' : confirmed ? 'sent' : 'pending';
  }
}

@Injectable()
export class PricingServiceBusRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  available = false;
  private client?: ServiceBusClient;
  private readonly senders: ServiceBusSender[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(PricingServiceBusRuntime.name);

  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    @Inject(PricingRepository) private readonly repository: PricingRepository,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.serviceBus) return;
    this.client = new ServiceBusClient(
      this.config.serviceBus.namespace,
      this.config.serviceBus.managedIdentityClientId
        ? new ManagedIdentityCredential({
            clientId: this.config.serviceBus.managedIdentityClientId,
          })
        : new DefaultAzureCredential(),
      {
        retryOptions: { maxRetries: 0, timeoutInMs: 5000 },
      },
    );
    const destinations: PricingPriceChangedQueue[] = [AUDIT_PILOT_QUEUE];
    if (this.config.serviceBus.fanoutEnabled)
      destinations.push(PROMOTIONS_PRICE_QUEUE);
    const workers = destinations.map((destination) => {
      const sender = this.client!.createSender(destination);
      this.senders.push(sender);
      return {
        sender,
        relay: new PricingServiceBusRelay(
          new PricingDeliveryStore(this.repository, destination),
          sender,
          destination,
        ),
      };
    });
    const tick = () => {
      this.active = (async () => {
        const results = await Promise.allSettled(
          workers.map(async ({ sender, relay }) => {
            // Establish the link even when there are no pending deliveries.
            await sender.createMessageBatch({ maxSizeInBytes: 256 * 1024 });
            return relay.publishOne();
          }),
        );
        this.available = results.every(
          (result) =>
            result.status === 'fulfilled' &&
            (result.value === 'empty' || result.value === 'sent'),
        );
      })()
        .catch(() => {
          this.available = false;
        })
        .finally(() => {
          if (!this.available) this.logger.warn('SERVICE_BUS_PRICING_PENDING');
          if (!this.stopped) this.timer = setTimeout(tick, 1000);
        });
    };
    tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
    this.available = false;
    try {
      await Promise.allSettled(this.senders.map((sender) => sender.close()));
    } finally {
      await this.client?.close();
    }
  }
}
