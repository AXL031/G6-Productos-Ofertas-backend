import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceiver,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';

export const combosServiceBusRoutes = {
  'g6.combos.from.catalog': [
    'catalog.product.deactivated',
    'catalog.sku.deactivated',
  ],
  'g6.combos.from.inventory': ['inventory.stock.changed'],
} as const;
export type CombosEventQueue = keyof typeof combosServiceBusRoutes;

export function readCombosServiceBus(env: NodeJS.ProcessEnv) {
  const provider = env.MESSAGING_PROVIDER;
  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN;
  const clientId = env.AZURE_CLIENT_ID;
  const enabled = env.COMBOS_SERVICE_BUS_EVENTS_ENABLED;
  if (
    (provider === undefined || provider === 'RABBITMQ') &&
    (enabled === undefined || enabled === 'false') &&
    namespace === undefined
  )
    return undefined;
  if (
    provider !== 'AZURE_SERVICE_BUS' ||
    (enabled !== 'true' && enabled !== 'false') ||
    env.COMBOS_AMQP_URL !== undefined ||
    (env.COMBOS_AMQP_ENABLED !== undefined &&
      env.COMBOS_AMQP_ENABLED !== 'false') ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      namespace ?? '',
    ) ||
    (clientId !== undefined &&
      (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId) ||
        /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(clientId))) ||
    (env.NODE_ENV === 'production' &&
      (env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true' ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        !clientId))
  )
    throw new Error('COMBOS_SERVICE_BUS_CONFIGURATION_INVALID');
  return { namespace: namespace!, clientId, enabled: enabled === 'true' };
}

type Config = NonNullable<ReturnType<typeof readCombosServiceBus>>;
type DeliveryHandler = (
  queue: CombosEventQueue,
  receiver: ServiceBusReceiver,
  message: ServiceBusReceivedMessage,
) => Promise<void>;

export class CombosServiceBus {
  private readonly client: ServiceBusClient;
  private readonly receivers: ServiceBusReceiver[] = [];
  private readonly subscriptions: { close(): Promise<void> }[] = [];
  private readonly active = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private probe?: Promise<void>;
  private stopped = false;
  available = false;

  constructor(
    config: Config,
    private readonly handle: DeliveryHandler,
  ) {
    this.client = new ServiceBusClient(
      config.namespace,
      config.clientId
        ? new ManagedIdentityCredential({ clientId: config.clientId })
        : new DefaultAzureCredential(),
    );
  }

  async start(): Promise<void> {
    const queues = Object.keys(combosServiceBusRoutes) as CombosEventQueue[];
    try {
      for (const queue of queues) {
        this.receivers.push(
          this.client.createReceiver(queue, {
            receiveMode: 'peekLock',
            skipParsingBodyAsJson: true,
            maxAutoLockRenewalDurationInMs: 60_000,
          }),
        );
      }
      if (!(await this.checkLinks(5000)))
        throw new Error('COMBOS_SERVICE_BUS_LINK_UNAVAILABLE');
      for (const [index, queue] of queues.entries()) {
        const receiver = this.receivers[index];
        this.subscriptions.push(
          receiver.subscribe(
            {
              processMessage: (message) => {
                const task = this.handle(queue, receiver, message).catch(() => {
                  this.available = false;
                });
                this.active.add(task);
                void task.then(() => this.active.delete(task));
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
      await this.close();
      throw new Error('COMBOS_SERVICE_BUS_START_FAILED');
    }
  }

  private async checkLinks(timeout: number): Promise<boolean> {
    const checks = await Promise.allSettled(
      this.receivers.map((receiver) =>
        receiver.peekMessages(1, { abortSignal: AbortSignal.timeout(timeout) }),
      ),
    );
    return checks.every((check) => check.status === 'fulfilled');
  }

  private scheduleProbe(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.probe = this.checkLinks(1000).then((ready) => {
        this.available = ready && !this.stopped;
        this.scheduleProbe();
      });
    }, 5000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.available = false;
    clearTimeout(this.timer);
    await Promise.allSettled(
      this.subscriptions.map((subscription) => subscription.close()),
    );
    await Promise.allSettled(this.active);
    await this.probe;
    await Promise.allSettled(
      this.receivers.map((receiver) => receiver.close()),
    );
    await this.client.close();
  }
}
