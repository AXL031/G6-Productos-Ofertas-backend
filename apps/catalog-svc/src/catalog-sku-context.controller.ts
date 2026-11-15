import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
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

  private parseBatch(body: unknown): string[] {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'skus')
    )
      throw new BadRequestException({ code: 'VALIDACION' });
    const skus = (body as Record<string, unknown>).skus;
    if (
      !Array.isArray(skus) ||
      skus.length < 1 ||
      skus.length > 100 ||
      !skus.every(
        (sku) =>
          typeof sku === 'string' &&
          sku.length > 0 &&
          sku.length <= 256 &&
          !sku.includes('\0'),
      )
    )
      throw new BadRequestException({ code: 'VALIDACION' });
    return skus;
  }

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

  @Post('contexto/lote')
  @HttpCode(200)
  @RequireCatalogIdentity({
    identity: 'service',
    scope: 'catalogo:leer',
    allowedClients: ['modulo-productos'],
  })
  async batchContext(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !isCorrelationId(correlationId))
      throw new BadRequestException();
    return { items: await this.repository.skuContexts(this.parseBatch(body)) };
  }
}
