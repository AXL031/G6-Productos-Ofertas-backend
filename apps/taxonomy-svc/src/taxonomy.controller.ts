import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import {
  AllowTaxonomyServiceClients,
  TaxonomyAuthGuard,
} from './taxonomy-auth.js';
import { ProblemDetailsException, esUuid } from './errors/taxonomy.errors.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import type { CategoriaDto, MarcaDto } from './taxonomy-svc.service.js';

type Consulta = Record<string, unknown>;

function validarEntrada(consulta: Consulta, correlationId?: string): void {
  if (correlationId !== undefined && !esUuid(correlationId)) {
    throw ProblemDetailsException.validacion(
      'X-Correlation-Id debe ser un UUID válido.',
    );
  }

  const parametros = Object.keys(consulta ?? {});
  if (parametros.length > 0) {
    throw ProblemDetailsException.validacion(
      'Parámetro(s) de consulta no soportado(s): ' +
        parametros.join(', ') +
        '. Esta operación no admite filtros ni paginación.',
    );
  }
}

@Controller('api/v1')
@UseGuards(TaxonomyAuthGuard)
export class TaxonomyController {
  constructor(private readonly taxonomyService: TaxonomySvcService) {}

  @Get('categorias')
  @AllowTaxonomyServiceClients(
    'modulo-marketplace',
    'modulo-chatbot',
    'modulo-retail',
  )
  async listarCategorias(
    @Query() consulta: Consulta,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<{ categories: CategoriaDto[] }> {
    validarEntrada(consulta, correlationId);
    return this.taxonomyService.listarCategorias();
  }

  @Get('marcas')
  @AllowTaxonomyServiceClients(
    'modulo-marketplace',
    'modulo-chatbot',
    'modulo-retail',
  )
  async listarMarcas(
    @Query() consulta: Consulta,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<{ brands: MarcaDto[] }> {
    validarEntrada(consulta, correlationId);
    return this.taxonomyService.listarMarcas();
  }
}
