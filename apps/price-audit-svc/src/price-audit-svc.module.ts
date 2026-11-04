import { Module, type DynamicModule } from '@nestjs/common';
import { PriceAuditSvcController } from './price-audit-svc.controller.js';
import { PriceAuditSvcService } from './price-audit-svc.service.js';
import {
  PRICE_AUDIT_CONFIG,
  validateEnvironment,
} from './config/environment.js';
import { AuditDatabase } from './persistence/audit.database.js';
import { AuditReadiness } from './health/audit-readiness.js';
import { HealthController } from './health/health.controller.js';
import { AuditReadGuard } from './http/audit-read.guard.js';
import {
  AUDIT_EXPORT_WORKER,
  AuditController,
} from './http/audit.controller.js';
import { AuditRepository } from './persistence/audit.repository.js';
import {
  AUDIT_PRICE_CHANGE_DECODER,
  AuditConsumer,
} from './messaging/audit-consumer.js';
import { decodePriceChange } from './messaging/price-change-decoder.js';
import { AuditFileExportWorker } from './exports/audit-file-worker.js';

@Module({
  imports: [],
  controllers: [PriceAuditSvcController, HealthController, AuditController],
  providers: [
    PriceAuditSvcService,
    AuditDatabase,
    AuditReadiness,
    AuditReadGuard,
    AuditRepository,
    AuditConsumer,
    { provide: AUDIT_PRICE_CHANGE_DECODER, useValue: decodePriceChange },
    AuditFileExportWorker,
    { provide: AUDIT_EXPORT_WORKER, useExisting: AuditFileExportWorker },
    {
      provide: PRICE_AUDIT_CONFIG,
      useFactory: () => validateEnvironment(process.env),
    },
  ],
})
export class PriceAuditSvcModule {
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    return {
      module: PriceAuditSvcModule,
      providers: [
        { provide: PRICE_AUDIT_CONFIG, useValue: validateEnvironment(env) },
      ],
    };
  }
}
