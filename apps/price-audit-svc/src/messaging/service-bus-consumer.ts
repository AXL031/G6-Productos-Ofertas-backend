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
import {
  ServiceBusClient,
  type ServiceBusReceiver,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { PRICE_AUDIT_CONFIG, type AuditConfig } from '../config/environment.js';
import { AuditRepository } from '../persistence/audit.repository.js';
import { AuditHttpError } from '../http/audit-http.error.js';
import { decodeAuditEnvelope } from './audit-envelope.js';
import { decodePriceChange } from './price-change-decoder.js';

const QUEUE = 'g6.price-audit.from.pricing';
export type AuditSettlement = Pick<
  ServiceBusReceiver,
  'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
>;

export class AuditServiceBusHandler {
  constructor(
    private readonly repository: Pick<AuditRepository, 'append'>,
    private readonly receiver: AuditSettlement,
  ) {}

  async handle(
    message: ServiceBusReceivedMessage,
  ): Promise<'completed' | 'abandoned' | 'dead-lettered'> {
    let decoded: ReturnType<typeof decodeAuditEnvelope>;
    let entries: ReturnType<typeof decodePriceChange>;
    try {
      const body: unknown = message.body;
      const content =
        typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : body instanceof Uint8Array
            ? body
            : undefined;
      if (
        !content ||
        content.byteLength > 256 * 1024 ||
        typeof message.messageId !== 'string' ||
        typeof message.correlationId !== 'string' ||
        message.subject !== 'pricing.price.changed' ||
        message.applicationProperties?.producer !== 'pricing-svc' ||
        message.applicationProperties?.schema_version !== 1 ||
        message.applicationProperties?.route_version !== 1
      )
        throw new AuditHttpError(400, 'VALIDACION');
      decoded = decodeAuditEnvelope(content, message);
      entries = decodePriceChange(decoded.data, decoded.occurredAt);
    } catch {
      // Broker DLQ is the durable disposition; failed settlement must remain recoverable.
      await this.receiver.deadLetterMessage(message, {
        deadLetterReason: 'INVALID_PRICING_CONTRACT',
        deadLetterErrorDescription:
          'Envelope or payload does not match the approved Pricing contract.',
      });
      return 'dead-lettered';
    }
    try {
      await this.repository.append(decoded, entries);
    } catch (error) {
      if (error instanceof AuditHttpError) {
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: 'INVALID_PRICING_CONTRACT',
          deadLetterErrorDescription:
            'The persisted audit rejected the Pricing contract.',
        });
        return 'dead-lettered';
      }
      await this.receiver.abandonMessage(message);
      return 'abandoned';
    }
    // Keep outside the persistence catch: failure after commit must not be misclassified.
    await this.receiver.completeMessage(message);
    return 'completed';
  }
}

@Injectable()
export class AuditServiceBusRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  available = false;
  private client?: ServiceBusClient;
  private receiver?: ServiceBusReceiver;
  private subscription?: { close(): Promise<void> };
  private opening?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly logger = new Logger(AuditServiceBusRuntime.name);

  constructor(
    @Inject(PRICE_AUDIT_CONFIG) private readonly config: AuditConfig,
    @Inject(AuditRepository) private readonly repository: AuditRepository,
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
    this.receiver = this.client.createReceiver(QUEUE, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
      maxAutoLockRenewalDurationInMs: 60_000,
    });
    const receiver = this.receiver;
    const handler = new AuditServiceBusHandler(this.repository, receiver);
    const open = () => {
      this.opening = receiver
        .peekMessages(1)
        .then(() => {
          if (this.stopped) return;
          this.subscription ??= receiver.subscribe(
            {
              processMessage: async (message) => {
                const task = handler.handle(message);
                this.active.add(task);
                try {
                  await task;
                  this.available = true;
                } catch (error) {
                  this.available = false;
                  throw error;
                } finally {
                  this.active.delete(task);
                }
              },
              processError: async () => {
                this.available = false;
                this.logger.warn('SERVICE_BUS_AUDIT_RECOVERY_PENDING');
                clearTimeout(this.timer);
                if (!this.stopped) this.timer = setTimeout(open, 2000);
              },
            },
            { autoCompleteMessages: false, maxConcurrentCalls: 1 },
          );
          this.available = true;
        })
        .catch(() => {
          this.available = false;
          if (!this.stopped) this.timer = setTimeout(open, 2000);
        });
    };
    open();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.opening;
    try {
      await this.subscription?.close();
      await Promise.allSettled(this.active);
    } finally {
      this.available = false;
      try {
        await this.receiver?.close();
      } finally {
        await this.client?.close();
      }
    }
  }
}
