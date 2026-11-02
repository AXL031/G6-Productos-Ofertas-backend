import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { CatalogAuthGuard, RequireCatalogIdentity } from './catalog-auth.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { isCorrelationId } from './correlation.js';

// Private g6-http read for Pricing; never calls commercial reads or Pricing.
@Controller('api/v1/productos/skus')
@UseGuards(CatalogAuthGuard)
export class CatalogSkuContextController {
  constructor(private readonly repository: PostgresCatalogRepository) {}

  @Get(':sku/contexto')
  @RequireCatalogIdentity({
    identity: 'service',
    scope: 'catalogo:leer',
    allowedClients: ['modulo-productos'],
  })
  async context(
    @Param('sku') sku: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !isCorrelationId(correlationId))
      throw new BadRequestException();
    const result = await this.repository.skuContext(sku).catch(() => {
      throw new ServiceUnavailableException({
        code: 'SERVICIO_NO_DISPONIBLE',
      });
    });
    if (!result) throw new NotFoundException({ code: 'SKU_NO_ENCONTRADO' });
    return result;
  }
}
