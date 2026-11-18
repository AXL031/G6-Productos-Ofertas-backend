import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CatalogMessageService } from './catalog-message.service.js';
import { Database } from './database.js';
import {
  CatalogServiceBus,
  createCatalogServiceBus,
} from './catalog-service-bus.js';
import { relayCatalogDelivery } from './catalog-service-bus-relay.js';

const queues = [
  'g6.catalog.from.taxonomy',
  'g6.catalog.from.bulk',
  'g6.catalog.from.pricing',
  'g6.catalog.from.inventory',
] as const;

@Injectable()
export class CatalogServiceBusRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly bus?: CatalogServiceBus;
  private readonly stopReceivers: Array<() => Promise<void>> = [];
  private timer?: ReturnType<typeof setInterval>;
  private receiverRecoveryTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  private stopped = false;
  private busy = false;
  private recovering = false;

  constructor(
    private readonly database: Database,
    private readonly messages: CatalogMessageService,
  ) {
    this.bus = createCatalogServiceBus(process.env);
  }

  get required(): boolean {
    return this.bus !== undefined;
  }

  get ready(): boolean {
    return !this.required || (this.started && !this.stopped);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.bus) return;
    this.openReceivers();
    this.timer = setInterval(() => void this.relay(), 2000);
    this.timer.unref();
    await this.relay();
  }

  private openReceivers(): void {
    if (!this.bus || this.stopped) return;
    for (const queue of queues) {
      this.stopReceivers.push(
        this.bus.subscribe(queue, this.messages, () => {
          this.scheduleReceiverRecovery();
        }),
      );
    }
    this.started = true;
  }

  private scheduleReceiverRecovery(): void {
    this.started = false;
    if (this.receiverRecoveryTimer || this.stopped) return;
    this.receiverRecoveryTimer = setTimeout(() => {
      this.receiverRecoveryTimer = undefined;
      void this.recoverReceivers();
    }, 2000);
    this.receiverRecoveryTimer.unref();
  }

  private async recoverReceivers(): Promise<void> {
    if (this.recovering || this.stopped || !this.bus) return;
    this.recovering = true;
    const previous = this.stopReceivers.splice(0);
    await Promise.allSettled(previous.map((stop) => stop()));
    try {
      this.openReceivers();
    } catch {
      process.stderr.write('CATALOG_SERVICE_BUS_RECEIVER_RECOVERY_FAILURE\n');
      this.scheduleReceiverRecovery();
    } finally {
      this.recovering = false;
    }
  }

  private async relay(): Promise<void> {
    if (!this.bus || this.busy || this.stopped) return;
    this.busy = true;
    try {
      await relayCatalogDelivery(this.database, this.bus);
    } catch {
      // Emit a stable operational code; SDK, SQL and credential errors may contain secrets.
      process.stderr.write('CATALOG_SERVICE_BUS_RUNTIME_FAILURE\n');
    } finally {
      this.busy = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.receiverRecoveryTimer) clearTimeout(this.receiverRecoveryTimer);
    await Promise.allSettled(this.stopReceivers.map((stop) => stop()));
    await this.bus?.close();
  }
}
