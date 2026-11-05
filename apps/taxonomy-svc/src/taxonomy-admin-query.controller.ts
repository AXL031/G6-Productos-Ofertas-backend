import {
  Controller,
  Get,
  Headers,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AllowTaxonomyServiceRead,
  RequireTaxonomyCommercialUser,
  TaxonomyUserGuard,
} from './taxonomy-auth.js';
import { ProblemDetailsException, esUuid } from './errors/taxonomy.errors.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import {
  MasterAdminQueryService,
  type CategoriaTreeNode,
} from './domain/master-admin-query.service.js';

@Controller('api/v1')
@UseGuards(TaxonomyUserGuard)
export class TaxonomyAdminQueryController {
  constructor(
    private readonly taxonomy: TaxonomySvcService,
    private readonly adminQueries: MasterAdminQueryService,
  ) {}

  @Get('categorias/arbol')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async obtenerArbolCategoriasAdmin(
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<CategoriaTreeNode[]> {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    return this.adminQueries.arbol();
  }

  @Get('categorias/administracion')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async listarCategoriasAdmin(
    @Query('pagina') paginaTexto?: string,
    @Query('tamanio') tamanioTexto?: string,
    @Query('estado') estado?: string,
    @Query('categoriaPadreId') categoriaPadreId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    if (estado !== undefined && !['ACTIVO', 'INACTIVO'].includes(estado))
      throw ProblemDetailsException.validacion('Estado inválido.');
    if (categoriaPadreId !== undefined && !esUuid(categoriaPadreId))
      throw ProblemDetailsException.validacion('categoriaPadreId inválido.');
    const pagina = paginaTexto === undefined ? 1 : Number(paginaTexto);
    const tamanio = tamanioTexto === undefined ? 20 : Number(tamanioTexto);
    if (
      !Number.isSafeInteger(pagina) ||
      pagina < 1 ||
      !Number.isSafeInteger(tamanio) ||
      tamanio < 1 ||
      tamanio > 200
    )
      throw ProblemDetailsException.validacion('Paginación inválida.');
    return this.adminQueries.categoriasAdmin({
      pagina,
      tamanio,
      estado,
      categoriaPadreId,
    });
  }

  @Get('marcas/administracion')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async listarMarcasAdmin(
    @Query('pagina') paginaTexto?: string,
    @Query('tamanio') tamanioTexto?: string,
    @Query('estado') estado?: string,
    @Query('q') q?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    if (estado !== undefined && !['ACTIVO', 'INACTIVO'].includes(estado))
      throw ProblemDetailsException.validacion('Estado inválido.');
    const pagina = paginaTexto === undefined ? 1 : Number(paginaTexto);
    const tamanio = tamanioTexto === undefined ? 20 : Number(tamanioTexto);
    if (
      !Number.isSafeInteger(pagina) ||
      pagina < 1 ||
      !Number.isSafeInteger(tamanio) ||
      tamanio < 1 ||
      tamanio > 200
    )
      throw ProblemDetailsException.validacion('Paginación inválida.');
    return this.adminQueries.marcasAdmin({ pagina, tamanio, estado, q });
  }

  @Get('marcas/:marcaId')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async obtenerMarcaAdmin(
    @Param('marcaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!esUuid(id) || (correlationId !== undefined && !esUuid(correlationId)))
      throw ProblemDetailsException.validacion('Identificador inválido.');
    const marca = await this.adminQueries.marca(id);
    if (!marca)
      throw new ProblemDetailsException({
        type: '/errores/marca-no-encontrada',
        title: 'Marca no encontrada',
        status: 404,
        code: 'MARCA_NO_ENCONTRADA',
      });
    if (marca.estado === 'PENDING_DEACTIVATION')
      throw new ProblemDetailsException({
        type: '/errores/servicio-no-disponible',
        title: 'Estado no representable por el contrato HTTP',
        status: 503,
        code: 'SERVICIO_NO_DISPONIBLE',
      });
    return marca;
  }

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
