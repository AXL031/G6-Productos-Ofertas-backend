import { Inject, Injectable, Optional } from '@nestjs/common';
import { AuditServiceBusRuntime } from '../messaging/service-bus-consumer.js';
import { AuditDatabase } from '../persistence/audit.database.js';
import { AuditConsumer } from '../messaging/audit-consumer.js';
import { PRICE_AUDIT_CONFIG, type AuditConfig } from '../config/environment.js';
import { AuditFileExportWorker } from '../exports/audit-file-worker.js';
@Injectable()
export class AuditReadiness {
  constructor(
    @Inject(AuditDatabase) private readonly database: AuditDatabase,
    @Inject(PRICE_AUDIT_CONFIG) private readonly config: AuditConfig,
    @Inject(AuditConsumer) private readonly consumer: AuditConsumer,
    @Inject(AuditFileExportWorker)
    private readonly exports: AuditFileExportWorker,
    @Optional()
    @Inject(AuditServiceBusRuntime)
    private readonly serviceBus?: AuditServiceBusRuntime,
  ) {}
  async check() {
    return (
      (!this.config.serviceBus || this.serviceBus?.available === true) &&
      (!this.config.amqpUrl || this.consumer.available) &&
      (await this.exports.ready()) &&
      (await this.database.check())
    );
  }
}
