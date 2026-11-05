import { Module, type DynamicModule } from '@nestjs/common';
import { PricingSvcController } from './pricing-svc.controller.js';
import { PricingSvcService } from './pricing-svc.service.js';
import { PRICING_CONFIG, validateEnvironment } from './config/environment.js';
import { HealthController } from './health/health.controller.js';
import { PricingReadiness } from './health/pricing-readiness.js';
import { PricingDatabase } from './persistence/pricing.database.js';
import { PricingRepository } from './persistence/pricing.repository.js';
import { PricingReadController } from './http/pricing-read.controller.js';
import { PricingReads } from './http/pricing-reads.js';
import { PricingReadGuard } from './http/pricing-read.guard.js';
import { PricingMutations } from './application/pricing-mutations.js';
import {
  CommercialPrices,
  PRICING_CATALOG_CONTEXT,
} from './http/commercial-prices.js';
import {
  CatalogContextHttp,
  PRICING_CATALOG_TOKEN,
} from './http/catalog-context.js';
import { CatalogServiceToken } from './http/catalog-token.js';
import { PricingOutboxRelay } from './messaging/outbox-relay.js';
import { createPricingPriceChangedFacts } from './messaging/pricing-fact.js';
import { PricingWriteAuthorization } from './http/pricing-write.authorization.js';
import { PricingScheduleReconciler } from './messaging/schedule-reconciler.js';
import { PricingProductInitialization } from './messaging/pricing-initialization.js';
import { CatalogSkuDeactivated } from './messaging/catalog-sku-deactivated.js';
import { PricingInboxConsumer } from './messaging/inbox-consumer.js';
import {
  PRICING_FACT_FACTORY,
  PRICING_WRITE_AUTHORIZER,
  PricingWriteController,
} from './http/pricing-write.controller.js';

@Module({
  imports: [],
  controllers: [
    PricingSvcController,
    HealthController,
    PricingReadController,
    PricingWriteController,
  ],
  providers: [
    PricingSvcService,
    PricingReadiness,
    PricingDatabase,
    PricingRepository,
    PricingReads,
    PricingReadGuard,
    PricingMutations,
    CommercialPrices,
    PricingOutboxRelay,
    PricingScheduleReconciler,
    PricingProductInitialization,
    CatalogSkuDeactivated,
    PricingInboxConsumer,
    PricingWriteAuthorization,
    CatalogContextHttp,
    { provide: PRICING_CATALOG_CONTEXT, useExisting: CatalogContextHttp },
    CatalogServiceToken,
    {
      provide: PRICING_CATALOG_TOKEN,
      useFactory: (tokens: CatalogServiceToken) => () => tokens.get(),
      inject: [CatalogServiceToken],
    },
    {
      provide: PRICING_WRITE_AUTHORIZER,
      useFactory: (authorization: PricingWriteAuthorization) =>
        authorization.authorize.bind(authorization),
      inject: [PricingWriteAuthorization],
    },
    { provide: PRICING_FACT_FACTORY, useValue: createPricingPriceChangedFacts },
    {
      provide: PRICING_CONFIG,
      useFactory: () => validateEnvironment(process.env),
    },
  ],
  exports: [PricingRepository, PricingMutations],
})
export class PricingSvcModule {
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    return {
      module: PricingSvcModule,
      providers: [
        { provide: PRICING_CONFIG, useValue: validateEnvironment(env) },
      ],
    };
  }
}
