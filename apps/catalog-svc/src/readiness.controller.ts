import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Database } from './database.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { CatalogAmqpRuntime } from './catalog-amqp.js';
import { CatalogServiceBusRuntime } from './catalog-service-bus.runtime.js';

@Controller('health')
export class ReadinessController {
  constructor(
    private readonly database: Database,
    private readonly repository: PostgresCatalogRepository,
    private readonly amqp: CatalogAmqpRuntime,
    private readonly serviceBus?: CatalogServiceBusRuntime,
  ) {}
  async checkReadiness(
    onProgress?: (stage: 'database' | 'catalog-read') => void,
  ): Promise<void> {
    await this.database.verifyIdentity();
    onProgress?.('database');
    if (this.amqp?.required && !this.amqp.ready) throw new Error();
    if (this.serviceBus?.required && !this.serviceBus.ready) throw new Error();

    await this.repository.checkReadinessAccess();
    onProgress?.('catalog-read');
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
