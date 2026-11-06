import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CatalogAuthGuard,
  RequireCatalogIdentity,
  type CatalogPrincipal,
} from './catalog-auth.js';
import { correlationId, isCorrelationId } from './correlation.js';
import { HistoricalRecoveryService } from './historical-recovery.service.js';

/** CONTRATO_CANDIDATO authorized for #194 DRAFT. Not a published OpenAPI claim.
 * This separate policy never inherits the ordinary mutations' demo allowance. */
@Controller('api/v1/productos')
@UseGuards(CatalogAuthGuard)
@RequireCatalogIdentity({ identity: 'user', roles: ['GESTOR_COMERCIAL'] })
export class HistoricalRecoveryController {
  constructor(private readonly service: HistoricalRecoveryService) {}

  @Post(':productoId/preparacion/recuperar-historica')
  @HttpCode(202)
  recover(
    @Req() request: Request & { catalogPrincipal?: CatalogPrincipal },
    @Body() body: unknown,
    @Headers('x-correlation-id') id?: string,
  ) {
    if (id !== undefined && !isCorrelationId(id))
      throw new BadRequestException();
    const principal = request.catalogPrincipal;
    if (principal?.kind !== 'user')
      throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    return this.service.recover(request.params.productoId as string, body, {
      subject: principal.subject,
      correlationId: correlationId(id),
    });
  }
}
