import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TaxonomyCommercialGuard, TaxonomyUserGuard } from './taxonomy-auth.js';
import { CategorySeoService } from './domain/category-seo.service.js';
import { ProblemDetailsException, esUuid } from './errors/taxonomy.errors.js';

function problem(status: number, code: string) {
  return new ProblemDetailsException({
    type: `/errores/${code.toLowerCase().replace(/_/g, '-')}`,
    title: status === 404 ? 'Recurso no encontrado' : 'Datos inválidos',
    status,
    code,
  });
}
@Controller('api/v1')
export class CategorySeoController {
  constructor(private readonly seo: CategorySeoService) {}

  @Post('seo/categorias/slug/resolver')
  @UseGuards(TaxonomyUserGuard, TaxonomyCommercialGuard)
  @HttpCode(200)
  async resolverPropuesta(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).nombre !== 'string' ||
      !(body as Record<string, string>).nombre.trim()
    )
      throw ProblemDetailsException.validacion('nombre es obligatorio.');
    const result = await this.seo.proponer((body as { nombre: string }).nombre);
    if (!result)
      throw ProblemDetailsException.validacion(
        'No se pudo proponer un slug válido.',
      );
    return result;
  }

  @Get('seo/:slug')
  async obtenerPublico(@Param('slug') slug: string) {
    const result = await this.seo.publico(slug);
    if (!result) throw problem(404, 'SLUG_NO_ENCONTRADO');
    return result;
  }

  @Get('seo/resoluciones/:slugAnterior')
  async resolverAnterior(@Param('slugAnterior') slug: string) {
    const result = await this.seo.resolver(slug);
    if (!result) throw problem(404, 'SLUG_NO_ENCONTRADO');
    return result;
  }

  @Get('categorias/:categoriaId/seo')
  @UseGuards(TaxonomyUserGuard, TaxonomyCommercialGuard)
  async obtenerAdmin(
    @Param('categoriaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!esUuid(id))
      throw ProblemDetailsException.validacion('Identificador inválido.');
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const result = await this.seo.obtener(id);
    if (!result) throw problem(404, 'CATEGORIA_NO_ENCONTRADA');
    return result;
  }

  @Patch('categorias/:categoriaId/seo')
  @UseGuards(TaxonomyUserGuard, TaxonomyCommercialGuard)
  async actualizar(
    @Param('categoriaId') id: string,
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!esUuid(id))
      throw ProblemDetailsException.validacion('Identificador inválido.');
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw ProblemDetailsException.validacion();
    const v = body as Record<string, unknown>;
    if (
      typeof v.slug !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug) ||
      (v.metaTitulo !== undefined &&
        v.metaTitulo !== null &&
        typeof v.metaTitulo !== 'string') ||
      (v.metaDescripcion !== undefined &&
        v.metaDescripcion !== null &&
        typeof v.metaDescripcion !== 'string')
    )
      throw problem(422, 'METADATOS_SEO_INVALIDOS');
    const result = await this.seo.actualizar(id, {
      slug: v.slug,
      metaTitulo: v.metaTitulo as string | null | undefined,
      metaDescripcion: v.metaDescripcion as string | null | undefined,
    });
    if (result === 'SLUG_DUPLICADO') throw problem(409, 'SLUG_DUPLICADO');
    if (result === 'NO_ENCONTRADA')
      throw problem(404, 'CATEGORIA_NO_ENCONTRADA');
    return result;
  }

  @Get('categorias/:categoriaId/seo/historial')
  @UseGuards(TaxonomyUserGuard, TaxonomyCommercialGuard)
  async historial(
    @Param('categoriaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!esUuid(id))
      throw ProblemDetailsException.validacion('Identificador inválido.');
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const result = await this.seo.historial(id);
    if (!result) throw problem(404, 'CATEGORIA_NO_ENCONTRADA');
    return result;
  }
}
