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

@Controller('health')
export class ReadinessController {
  constructor(
    private readonly database: Database,
    private readonly commercial: CommercialService,
    @Optional() private readonly config?: CatalogConfig,
    @Optional() private readonly pricing?: PricingClient,
    @Optional() private readonly repository?: PostgresCatalogRepository,
  ) {}
  @Get('ready')
  async ready() {
    try {
      await this.database.verifyIdentity();
      if (
        this.config?.marketplaceDemoPreview &&
        !this.config.readDemo?.enabled
      ) {
        if (!this.repository || !this.pricing) throw new Error();
        await this.repository.checkDemoReadAccess();
        await this.pricing.checkReady();
      } else {
        await this.commercial.list({
          canal: 'MARKETPLACE',
          pagina: 1,
          tamanio: 1,
          orden: 'NOMBRE_ASC',
        });
      }
      return { status: 'ready', service: 'catalog-svc' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
