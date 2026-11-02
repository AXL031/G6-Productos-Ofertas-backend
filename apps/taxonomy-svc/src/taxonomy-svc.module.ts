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

export interface OpcionesModuloTaxonomy {
  databaseUrl?: string;
}

@Module({
  imports: [],
  controllers: [TaxonomySvcController, TaxonomyController, ReadinessController],
  providers: [
    TaxonomySvcService,
    Database,
    DeactivationCheckService,
    DeactivationIntentService,
    proveedorDeRepositorio(),
    { provide: TAXONOMY_READINESS, useExisting: TAXONOMY_REPOSITORY },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class TaxonomySvcModule {
  static forRuntime(): DynamicModule {
    return {
      module: TaxonomySvcModule,
      providers: [
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
      };
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TaxonomySvcModule.forRoot con databaseUrl no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
      );
    }
    return {
      module: TaxonomySvcModule,
      providers: [proveedorDeRepositorio(opciones.databaseUrl)],
    };
  }
}
