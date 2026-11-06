import { Module } from '@nestjs/common';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkImportService } from './bulk-import.service.js';
import { BulkExportService } from './bulk-export.service.js';
import {
  parseBulkEnvironment,
  BULK_ENVIRONMENT,
  BULK_READINESS_POOL,
} from './config/bulk-environment.js';
import {
  BulkReadinessService,
  createBulkReadinessPool,
} from './health/bulk-readiness.service.js';
import { bulkDatabaseProvider } from './persistence/bulk.database.js';
import { bulkRepositoryProvider } from './persistence/bulk.repository.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import { BulkUserBearerGuard } from './auth/bulk-user-bearer.guard.js';
import { BulkOutboxRelay } from './messaging/bulk-outbox-relay.js';
import {
  BULK_AMQP_URL,
  configuredBulkAmqpUrl,
} from './messaging/bulk-rabbitmq.js';
import { CatalogBulkResultConsumer } from './messaging/catalog-bulk-result-consumer.js';
import { BULK_EXPORT_SOURCE } from './export/bulk-export-source.js';

@Module({
  imports: [],
  controllers: [BulkSvcController],
  providers: [
    BulkSvcService,
    BulkImportService,
    BulkExportService,
    { provide: BULK_EXPORT_SOURCE, useValue: null },
    BulkStorageService,
    BulkUserBearerGuard,
    BulkOutboxRelay,
    CatalogBulkResultConsumer,
    BulkReadinessService,
    bulkDatabaseProvider,
    bulkRepositoryProvider,
    {
      provide: BULK_ENVIRONMENT,
      useFactory: () => parseBulkEnvironment(process.env),
    },
    {
      provide: BULK_AMQP_URL,
      useFactory: () => configuredBulkAmqpUrl(process.env),
    },
    {
      provide: BULK_READINESS_POOL,
      inject: [BULK_ENVIRONMENT],
      useFactory: createBulkReadinessPool,
    },
  ],
})
export class BulkSvcModule {}
