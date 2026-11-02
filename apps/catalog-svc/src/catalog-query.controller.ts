import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CatalogAuthGuard,
  RequireCatalogIdentity,
  type CatalogPrincipal,
} from './catalog-auth.js';
import type { Request } from 'express';
import { CatalogQueryService } from './catalog-query.service.js';
import { isCorrelationId } from './correlation.js';
import { parseProductQuery } from './catalog-query.js';
import { UUID } from './catalog-messages.js';

@Controller('api/v1/productos')
@UseGuards(CatalogAuthGuard)
export class CatalogQueryController {
  constructor(private readonly service: CatalogQueryService) {}

  private validateCorrelation(value?: string): void {
    if (value !== undefined && !isCorrelationId(value))
      throw new BadRequestException();
  }

  @Get(':productoId')
  @RequireCatalogIdentity({
    demoRead: true,
    restrictedDemo: true,
    identity: 'either',
    roles: ['GESTOR_COMERCIAL'],
    scope: 'catalogo:leer',
    allowedClients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
  })
  product(
    @Param('productoId') productId: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
    @Req()
    request?: Request & {
      catalogPrincipal?: CatalogPrincipal;
      catalogRestrictedDemo?: boolean;
    },
  ) {
    this.validateCorrelation(correlationId);
    return this.service.product(
      productId,
      parseProductQuery(
        query,
        true,
        !(
          request?.catalogPrincipal?.kind === 'user' ||
          request?.catalogRestrictedDemo
        ),
      ).canal,
      correlationId,
      {
        authorization: request?.headers.authorization,
        user: request?.catalogPrincipal?.kind === 'user',
        restrictedDemo: request?.catalogRestrictedDemo,
      },
    );
  }

  @Post('datos-fisicos/consulta')
  @HttpCode(200)
  @RequireCatalogIdentity({
    identity: 'service',
    scope: 'productos:fisicos:leer',
    allowedClients: ['modulo-despacho'],
  })
  physicalData(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.validateCorrelation(correlationId);
    return this.service.physicalData(body);
  }

  @Get(':productoId/preparacion')
  @RequireCatalogIdentity({
    restrictedDemo: true,
    identity: 'user',
    roles: ['GESTOR_COMERCIAL'],
  })
  preparation(
    @Param('productoId') productId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.validateCorrelation(correlationId);
    return this.service.preparation(productId);
  }

  @Get(':productoId/variantes')
  @RequireCatalogIdentity({
    restrictedDemo: true,
    identity: 'user',
    roles: ['GESTOR_COMERCIAL'],
  })
  variants(
    @Param('productoId') productId: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.validateCorrelation(correlationId);
    if (!UUID.test(productId)) throw new BadRequestException();
    return this.service.variants(productId, query);
  }

  @Get(':productoId/variantes/:variantId')
  @RequireCatalogIdentity({
    restrictedDemo: true,
    identity: 'user',
    roles: ['GESTOR_COMERCIAL'],
  })
  variant(
    @Param('productoId') productId: string,
    @Param('variantId') variantId: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.validateCorrelation(correlationId);
    if (
      !UUID.test(productId) ||
      !UUID.test(variantId) ||
      Object.keys(query).length
    )
      throw new BadRequestException();
    return this.service.variant(productId, variantId);
  }

  @Post('codigos-barras/resolver')
  @HttpCode(200)
  @RequireCatalogIdentity({
    identity: 'service',
    scope: 'catalogo:leer',
    allowedClients: ['modulo-retail'],
  })
  resolveBarcode(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.validateCorrelation(correlationId);
    return this.service.resolveBarcode(body);
  }
}
