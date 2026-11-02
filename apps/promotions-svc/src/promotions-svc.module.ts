import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  PROMOTIONS_OPERATION_LOGGER,
  PromotionsOperationLogger,
} from './infrastructure/logging/operation-logger.js';
import { PromotionsObservationInterceptor } from './http/observation-interceptor.js';
import { PromotionsReadinessMonitor } from './health/promotions-readiness-monitor.js';
import { PROMOTIONS_CLOCK } from './domain/clock.js';
import { PromotionsSvcController } from './promotions-svc.controller.js';
import { PromotionsSvcService } from './promotions-svc.service.js';
import {
  PROMOTIONS_SERVICE_TOKENS,
  unavailableServiceTokens,
  commercialProvider,
  adminReferenceProvider,
} from './infrastructure/http/integration-providers.js';
import { couponProviders } from './coupons/coupon-providers.js';
import {
  PromotionsConfigService,
  readPromotionsEnvironment,
  validatePromotionsConfiguration,
} from './infrastructure/config/promotions-config.js';
import {
  PROMOTIONS_DEPENDENCY_PROBES,
  PromotionsReadinessService,
} from './health/promotions-readiness.service.js';
import { nativePromotionsDependencyProbes } from './health/promotions-dependency-probes.js';
import { COMMERCIAL_CONTEXT } from './domain/commercial-context.js';
import {
  PromotionsQueryController,
  PromotionsProblemFilter,
} from './http/query-controller.js';
import { PromotionsQueryService } from './http/query-service.js';
import { PromotionsWriteController } from './http/write-controller.js';
import { PromotionsWriteService } from './http/write-service.js';
import { ADMIN_REFERENCES } from './domain/admin-references.js';
import {
  PROMOTIONS_JWKS,
  PromotionsIdentity,
  PromotionsQueryGuard,
  remotePromotionsKeys,
} from './http/promotions-identity.js';

@Module({
  imports: [],
  controllers: [
    PromotionsSvcController,
    PromotionsQueryController,
    PromotionsWriteController,
  ],
  providers: [
    ...couponProviders,
    { provide: PROMOTIONS_CLOCK, useValue: { now: () => new Date() } },
    PromotionsQueryService,
    PromotionsWriteService,
    { provide: PROMOTIONS_SERVICE_TOKENS, useValue: unavailableServiceTokens },
    {
      provide: ADMIN_REFERENCES,
      inject: [PromotionsConfigService, PROMOTIONS_SERVICE_TOKENS],
      useFactory: adminReferenceProvider,
    },
    PromotionsIdentity,
    PromotionsQueryGuard,
    { provide: APP_FILTER, useClass: PromotionsProblemFilter },
    {
      provide: PROMOTIONS_OPERATION_LOGGER,
      useFactory: () => new PromotionsOperationLogger(),
    },
    { provide: APP_INTERCEPTOR, useClass: PromotionsObservationInterceptor },
    {
      provide: COMMERCIAL_CONTEXT,
      inject: [PromotionsConfigService, PROMOTIONS_SERVICE_TOKENS],
      useFactory: commercialProvider,
    },
    {
      provide: PROMOTIONS_JWKS,
      inject: [PromotionsConfigService],
      useFactory: remotePromotionsKeys,
    },
    PromotionsSvcService,
    {
      provide: PromotionsConfigService,
      useFactory: () =>
        new PromotionsConfigService(
          validatePromotionsConfiguration(readPromotionsEnvironment()),
        ),
    },
    {
      provide: PROMOTIONS_DEPENDENCY_PROBES,
      inject: [PromotionsConfigService],
      useFactory: nativePromotionsDependencyProbes,
    },
    PromotionsReadinessService,
    PromotionsReadinessMonitor,
  ],
})
export class PromotionsSvcModule {}
