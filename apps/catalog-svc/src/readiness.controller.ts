import {
  Controller,
  Get,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Database } from './database.js';
import { CommercialService } from './commercial.service.js';
import { CatalogConfig } from './config.js';
import { PricingClient } from './pricing.client.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { CatalogAmqpRuntime } from './catalog-amqp.js';

@Controller('health')
export class ReadinessController {
  constructor(
    private readonly database: Database,
    private readonly commercial: CommercialService,
    @Optional() private readonly config?: CatalogConfig,
    @Optional() private readonly pricing?: PricingClient,
    @Optional() private readonly repository?: PostgresCatalogRepository,
    @Optional() private readonly amqp?: CatalogAmqpRuntime,
  ) {}
  async checkReadiness(
    onProgress?: (
      stage: 'database' | 'catalog-read' | 'pricing' | 'commercial',
    ) => void,
  ): Promise<void> {
    await this.database.verifyIdentity();
    onProgress?.('database');
    if (this.amqp?.required && !this.amqp.ready) throw new Error();

    if (this.config?.readDemo?.enabled) {
      if (!this.repository) throw new Error();
      await this.repository.checkDemoReadAccess();
      onProgress?.('catalog-read');
      return;
    }

    if (this.config?.marketplaceDemoPreview) {
      if (!this.repository || !this.pricing) throw new Error();
      await this.repository.checkDemoReadAccess();
      onProgress?.('catalog-read');
      await this.pricing.checkReady();
      onProgress?.('pricing');
      return;
    }

    await this.commercial.list({
      canal: 'MARKETPLACE',
      pagina: 1,
      tamanio: 1,
      orden: 'NOMBRE_ASC',
    });
    onProgress?.('commercial');
  }

  @Get('ready')
  async ready() {
    try {
      await this.checkReadiness();
      return { status: 'ready', service: 'catalog-svc' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
