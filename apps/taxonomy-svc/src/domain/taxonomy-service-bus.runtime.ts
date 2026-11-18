import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceiver,
  type ServiceBusReceivedMessage,
  type ServiceBusSender,
} from '@azure/service-bus';
import {
  catalogTaxonomyQueue,
  taxonomyCatalogQueue,
  taxonomyServiceBusEvents,
  type readTaxonomyServiceBus,
} from '../config/service-bus.js';
import {
  parseChecked,
  type TaxonomyMessageStore,
} from '../persistence/taxonomy-message.store.js';

type Config = NonNullable<ReturnType<typeof readTaxonomyServiceBus>>;
type Store = Pick<
  TaxonomyMessageStore,
  'consumir' | 'claimServiceBusDelivery' | 'finishServiceBusDelivery'
>;

function envelope(row: Record<string, unknown>) {
  const payload = row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const value = payload as Record<string, unknown>;
  const name = row.event_name;
  if (
    typeof name !== 'string' ||
    !(taxonomyServiceBusEvents as readonly string[]).includes(name)
  )
    return;
  const kind = name.endsWith('.requested')
    ? 'command'
    : name.endsWith('.rejected')
      ? 'result'
      : 'event';
  if (
    typeof row.message_id !== 'string' ||
    typeof row.correlation_id !== 'string' ||
    value.message_id !== row.message_id ||
    value.correlation_id !== row.correlation_id ||
    value.name !== name ||
    value.kind !== kind ||
    value.producer !== 'taxonomy-svc' ||
    value.schema_version !== 1 ||
    !value.data ||
    typeof value.data !== 'object' ||
    Array.isArray(value.data)
  )
    return;
  return {
    body: Buffer.from(JSON.stringify(value)),
    messageId: row.message_id,
    correlationId: row.correlation_id,
    contentType: 'application/json',
    subject: name,
    applicationProperties: {
      producer: 'taxonomy-svc',
      schema_version: 1,
      route_version: 1,
    },
  };
}

export async function publishTaxonomyDelivery(
  store: Pick<Store, 'claimServiceBusDelivery' | 'finishServiceBusDelivery'>,
  sender: Pick<ServiceBusSender, 'createMessageBatch' | 'sendMessages'>,
): Promise<boolean> {
  const claim = await store.claimServiceBusDelivery();
  if (!claim) return true;
  const message = envelope(claim.row);
  let outcome: 'sent' | 'pending' | 'terminal' = message
    ? 'pending'
    : 'terminal';
  try {
    if (message) {
      const batch = await sender.createMessageBatch({
        maxSizeInBytes: 256 * 1024,
      });
      if (!batch.tryAddMessage(message)) outcome = 'terminal';
      else {
        await sender.sendMessages(batch, {
          abortSignal: AbortSignal.timeout(10_000),
        });
        outcome = 'sent';
      }
    }
  } catch {
    // A lost send confirmation keeps the claim pending under the same MessageId.
  }
  return (
    (await store.finishServiceBusDelivery(claim, outcome)) && outcome === 'sent'
  );
}

export async function receiveTaxonomyDelivery(
  store: Pick<Store, 'consumir'>,
  receiver: Pick<
    ServiceBusReceiver,
    'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
  >,
  message: ServiceBusReceivedMessage,
): Promise<void> {
  let checked: ReturnType<typeof parseChecked>;
  try {
    if (
      !(message.body instanceof Uint8Array) ||
      message.body.byteLength > 256 * 1024 ||
      message.contentType !== 'application/json'
    )
      throw new Error('INVALID_ENVELOPE');
    checked = parseChecked(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(message.body),
      ),
    );
    const tags = message.applicationProperties ?? {};
    if (
      message.subject !== checked.name ||
      message.messageId !== checked.message_id ||
      message.correlationId !== checked.correlation_id ||
      (Object.hasOwn(tags, 'producer') && tags.producer !== checked.producer) ||
      (Object.hasOwn(tags, 'schema_version') &&
        tags.schema_version !== checked.schema_version) ||
      (Object.hasOwn(tags, 'route_version') && tags.route_version !== 1)
    )
      throw new Error('INVALID_ENVELOPE');
  } catch {
    await receiver.deadLetterMessage(message, {
      deadLetterReason: 'INVALID_TAXONOMY_CHECK_RESULT',
      deadLetterErrorDescription: 'Contract or queue validation failed',
    });
    return;
  }
  try {
    await store.consumir(checked);
  } catch {
    await receiver.abandonMessage(message);
    return;
  }
  await receiver.completeMessage(message);
}

export class TaxonomyServiceBusRuntime {
  private client?: ServiceBusClient;
  private receiver?: ServiceBusReceiver;
  private sender?: ServiceBusSender;
  private subscription?: { close(): Promise<void> };
  private timer?: ReturnType<typeof setTimeout>;
  private tick?: Promise<void>;
  private readonly deliveries = new Set<Promise<void>>();
  private stopped = false;
  available = false;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  start(): void {
    if (!this.config.enabled || this.client || this.stopped) return;
    this.client = new ServiceBusClient(
      this.config.namespace,
      this.config.clientId
        ? new ManagedIdentityCredential({ clientId: this.config.clientId })
        : new DefaultAzureCredential(),
      { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
    );
    const receiver = this.client.createReceiver(catalogTaxonomyQueue, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
      maxAutoLockRenewalDurationInMs: 60_000,
    });
    this.receiver = receiver;
    const sender = this.client.createSender(taxonomyCatalogQueue);
    this.sender = sender;
    this.subscription = receiver.subscribe(
      {
        processMessage: (message) => {
          const task = receiveTaxonomyDelivery(
            this.store,
            receiver,
            message,
          ).catch(() => {
            this.available = false;
          });
          this.deliveries.add(task);
          void task.then(() => this.deliveries.delete(task));
          return task;
        },
        processError: async () => {
          this.available = false;
        },
      },
      { autoCompleteMessages: false, maxConcurrentCalls: 1 },
    );
    const cycle = () => {
      this.tick = Promise.all([
        receiver.peekMessages(1, { abortSignal: AbortSignal.timeout(5000) }),
        sender.createMessageBatch({ maxSizeInBytes: 256 * 1024 }),
      ])
        .then(() => publishTaxonomyDelivery(this.store, sender))
        .then((ready) => {
          this.available = ready && !this.stopped;
        })
        .catch(() => {
          this.available = false;
        })
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(cycle, 1000);
            this.timer.unref();
          }
        });
    };
    cycle();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.available = false;
    clearTimeout(this.timer);
    await this.subscription?.close().catch(() => undefined);
    await this.tick;
    await Promise.allSettled(this.deliveries);
    await Promise.allSettled([this.receiver?.close(), this.sender?.close()]);
    await this.client?.close();
  }
}
