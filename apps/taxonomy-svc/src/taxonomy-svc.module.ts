import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { ReadinessController } from './health/readiness.controller.js';
import { TAXONOMY_READINESS } from './health/readiness.port.js';
import { proveedorDeRepositorio } from './persistence/persistence.providers.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { TaxonomySvcController } from './taxonomy-svc.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { Database } from './database.js';
import { PostgresTaxonomyRepository } from './postgres-taxonomy.repository.js';
import { DeactivationCheckService } from './domain/deactivation-check.service.js';
import { DeactivationIntentService } from './domain/deactivation-intent.service.js';
import { BrandReactivationService } from './domain/brand-reactivation.service.js';
import { CategoryReactivationService } from './domain/category-reactivation.service.js';
import { CategoryCreateService } from './domain/category-create.service.js';
import { CategoryUpdateService } from './domain/category-update.service.js';
import { BrandWriteService } from './domain/brand-write.service.js';
import { TaxonomyWriteController } from './taxonomy-write.controller.js';
import { DeactivationRecoveryRunner } from './domain/deactivation-integration.ports.js';
import { TaxonomyAmqpRuntime } from './domain/taxonomy-amqp.runtime.js';
import { TaxonomyMessageStore } from './persistence/taxonomy-message.store.js';
import {
  TAXONOMY_SECURITY_CONFIG,
  TaxonomyAuthGuard,
  TaxonomyTokenVerifier,
  readTaxonomySecurityConfig,
  TAXONOMY_DEMO_ENABLED,
  readTaxonomyDemoConfig,
  TaxonomyUserGuard,
} from './taxonomy-auth.js';

export interface OpcionesModuloTaxonomy {
  databaseUrl?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
}

@Module({
  imports: [],
  controllers: [
    TaxonomySvcController,
    TaxonomyController,
    TaxonomyWriteController,
    ReadinessController,
  ],
  providers: [
    TaxonomySvcService,
    Database,
    DeactivationCheckService,
    DeactivationIntentService,
    DeactivationRecoveryRunner,
    TaxonomyAmqpRuntime,
    TaxonomyMessageStore,
    TaxonomyAuthGuard,
    TaxonomyUserGuard,
    BrandReactivationService,
    CategoryReactivationService,
    CategoryCreateService,
    CategoryUpdateService,
    BrandWriteService,
    TaxonomyTokenVerifier,
    {
      provide: TAXONOMY_DEMO_ENABLED,
      useFactory: () => readTaxonomyDemoConfig(process.env),
    },
    {
      provide: TAXONOMY_SECURITY_CONFIG,
      useFactory: () => readTaxonomySecurityConfig(process.env),
    },
    proveedorDeRepositorio(),
    { provide: TAXONOMY_READINESS, useExisting: TAXONOMY_REPOSITORY },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class TaxonomySvcModule {
  static forRuntime(
    env: Readonly<NodeJS.ProcessEnv> = process.env,
  ): DynamicModule {
    return {
      module: TaxonomySvcModule,
      providers: [
        {
          provide: TAXONOMY_DEMO_ENABLED,
          useValue: readTaxonomyDemoConfig(env),
        },
        {
          provide: TAXONOMY_SECURITY_CONFIG,
          useValue: readTaxonomySecurityConfig(env),
        },
        {
          provide: TAXONOMY_REPOSITORY,
          useFactory: (db: Database) => new PostgresTaxonomyRepository(db),
          inject: [Database],
        },
      ],
    };
  }

  static forRoot(opciones: OpcionesModuloTaxonomy = {}): DynamicModule {
    if (!opciones.databaseUrl) {
      return {
        module: TaxonomySvcModule,
        providers: [
          {
            provide: TAXONOMY_DEMO_ENABLED,
            useValue: readTaxonomyDemoConfig(opciones.env ?? process.env),
          },
          {
            provide: TAXONOMY_SECURITY_CONFIG,
            useValue: readTaxonomySecurityConfig(opciones.env ?? process.env),
          },
        ],
      };
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TaxonomySvcModule.forRoot con databaseUrl no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
      );
    }
    return {
      module: TaxonomySvcModule,
      providers: [
        {
          provide: TAXONOMY_DEMO_ENABLED,
          useValue: readTaxonomyDemoConfig(opciones.env ?? process.env),
        },
        proveedorDeRepositorio(opciones.databaseUrl),
        {
          provide: TAXONOMY_SECURITY_CONFIG,
          useValue: readTaxonomySecurityConfig(opciones.env ?? process.env),
        },
      ],
    };
  }
}
