import { Inject, Injectable } from '@nestjs/common';
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
  ) {}
  async check() {
    return (
      (!this.config.amqpUrl || this.consumer.available) &&
      (await this.exports.ready()) &&
      (await this.database.check())
    );
  }
}
