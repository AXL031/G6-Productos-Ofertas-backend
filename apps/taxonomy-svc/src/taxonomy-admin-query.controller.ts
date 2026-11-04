import { Controller, Get, Headers, Param, UseGuards } from '@nestjs/common';
import {
  AllowTaxonomyServiceRead,
  RequireTaxonomyCommercialUser,
  TaxonomyUserGuard,
} from './taxonomy-auth.js';
import { ProblemDetailsException, esUuid } from './errors/taxonomy.errors.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';

@Controller('api/v1')
@UseGuards(TaxonomyUserGuard)
export class TaxonomyAdminQueryController {
  constructor(private readonly taxonomy: TaxonomySvcService) {}

  @Get('categorias/:categoriaId')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async obtenerCategoriaAdmin(
    @Param('categoriaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!esUuid(id))
      throw ProblemDetailsException.validacion('Identificador inválido.');
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const categoria = await this.taxonomy.obtenerCategoriaAdmin(id);
    if (!categoria)
      throw new ProblemDetailsException({
        type: '/errores/categoria-no-encontrada',
        title: 'Categoría no encontrada',
        status: 404,
        code: 'CATEGORIA_NO_ENCONTRADA',
      });
    return categoria;
  }
}
