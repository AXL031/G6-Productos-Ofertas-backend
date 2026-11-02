import {
  BadRequestException,
  ForbiddenException,
  Controller,
  Get,
  Headers,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CommercialService } from './commercial.service.js';
import { isCorrelationId } from './correlation.js';
import { parseProductQuery } from './catalog-query.js';
import {
  CatalogAuthGuard,
  RequireCatalogIdentity,
  type CatalogPrincipal,
} from './catalog-auth.js';

@Controller('api/v1/productos')
@UseGuards(CatalogAuthGuard)
export class CommercialController {
  constructor(private readonly service: CommercialService) {}
  private validateCorrelation(value?: string): void {
    if (value !== undefined && !isCorrelationId(value))
      throw new BadRequestException();
  }
  @Get()
  @RequireCatalogIdentity({
    marketplacePreviewRead: true,
    demoRead: true,
    restrictedDemo: true,
    identity: 'either',
    roles: ['GESTOR_COMERCIAL'],
    scope: 'catalogo:leer',
    allowedClients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
  })
  list(
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
    @Req()
    request?: Request & {
      catalogPrincipal?: CatalogPrincipal;
      catalogRestrictedDemo?: boolean;
      catalogDemoRead?: boolean;
      catalogDemoPreview?: boolean;
    },
  ) {
    this.validateCorrelation(correlationId);
    if (
      query.estado !== undefined &&
      !request?.catalogDemoRead &&
      !request?.catalogRestrictedDemo &&
      !request?.catalogDemoPreview &&
      (request?.catalogPrincipal?.kind !== 'user' ||
        !request.catalogPrincipal.roles.includes('GESTOR_COMERCIAL'))
    )
      throw new ForbiddenException();
    const administrativeState =
      request?.catalogDemoRead ||
      request?.catalogRestrictedDemo ||
      (request?.catalogPrincipal?.kind === 'user' &&
        request.catalogPrincipal.roles.includes('GESTOR_COMERCIAL'));
    return this.service.list(
      parseProductQuery(
        query,
        false,
        !(
          request?.catalogPrincipal?.kind === 'user' ||
          request?.catalogRestrictedDemo
        ),
      ),
      correlationId,
      administrativeState,
      {
        authorization: request?.headers.authorization,
        user: request?.catalogPrincipal?.kind === 'user',
        restrictedDemo: request?.catalogRestrictedDemo,
      },
    );
  }
  @Get('por-slug/:slug')
  @RequireCatalogIdentity({
    marketplacePreviewRead: true,
    demoRead: true,
    restrictedDemo: true,
    identity: 'either',
    roles: ['GESTOR_COMERCIAL'],
    scope: 'catalogo:leer',
    allowedClients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
  })
  detail(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
    @Req()
    request?: Request & {
      catalogPrincipal?: CatalogPrincipal;
      catalogRestrictedDemo?: boolean;
    },
  ) {
    this.validateCorrelation(correlationId);
    return this.service.detail(
      slug,
      parseProductQuery(
        query,
        true,
        !(
          request?.catalogPrincipal?.kind === 'user' ||
          request?.catalogRestrictedDemo
        ),
      ),
      correlationId,
      {
        authorization: request?.headers.authorization,
        user: request?.catalogPrincipal?.kind === 'user',
        restrictedDemo: request?.catalogRestrictedDemo,
      },
    );
  }
}
