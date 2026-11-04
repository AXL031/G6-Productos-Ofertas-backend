import {
  Controller,
  Body,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TaxonomyUserGuard, TaxonomyCommercialGuard } from './taxonomy-auth.js';
import { BrandReactivationService } from './domain/brand-reactivation.service.js';
import { CategoryReactivationService } from './domain/category-reactivation.service.js';
import { CategoryCreateService } from './domain/category-create.service.js';
import {
  CategoryUpdateService,
  type CambioCategoria,
} from './domain/category-update.service.js';
import {
  BrandWriteService,
  type EntradaMarca,
} from './domain/brand-write.service.js';
import {
  MasterDeactivationRequestService,
  type SolicitudMaestra,
} from './domain/master-deactivation-request.service.js';
import { validarLogo } from './domain/brand-logo.js';
import { esPaisIso } from './domain/iso-country.js';
import { ProblemDetailsException, esUuid } from './errors/taxonomy.errors.js';

@Controller('api/v1')
@UseGuards(TaxonomyUserGuard)
export class TaxonomyWriteController {
  constructor(
    private readonly reactivacion: BrandReactivationService,
    private readonly categorias: CategoryReactivationService,
    private readonly crearCategorias: CategoryCreateService,
    private readonly marcas: BrandWriteService,
    private readonly actualizarCategorias: CategoryUpdateService,
    private readonly bajas: MasterDeactivationRequestService,
  ) {}

  @Patch('categorias/:categoriaId')
  @UseGuards(TaxonomyCommercialGuard)
  async actualizarCategoria(
    @Param('categoriaId') id: string,
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion(
        'X-Correlation-Id debe ser un UUID válido.',
      );
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw ProblemDetailsException.validacion('Cuerpo inválido.');
    const data = body as Record<string, unknown>;
    if (
      (data.nombre !== undefined &&
        (typeof data.nombre !== 'string' || !data.nombre.trim())) ||
      (data.descripcion != null && typeof data.descripcion !== 'string') ||
      (data.categoriaPadreId != null && !esUuid(data.categoriaPadreId)) ||
      (data.orden != null &&
        (typeof data.orden !== 'number' ||
          !Number.isSafeInteger(data.orden) ||
          data.orden < 0)) ||
      (data.imagenUrl != null && typeof data.imagenUrl !== 'string') ||
      (data.version != null &&
        (typeof data.version !== 'number' ||
          !Number.isSafeInteger(data.version) ||
          data.version < 0))
    )
      throw ProblemDetailsException.validacion('Datos de categoría inválidos.');
    if (typeof data.imagenUrl === 'string') {
      try {
        new URL(data.imagenUrl);
      } catch {
        throw ProblemDetailsException.validacion(
          'imagenUrl debe ser una URI válida.',
        );
      }
    }
    const entrada: CambioCategoria = {};
    if (typeof data.nombre === 'string') entrada.nombre = data.nombre;
    if (data.descripcion === null || typeof data.descripcion === 'string')
      entrada.descripcion = data.descripcion;
    if (
      data.categoriaPadreId === null ||
      typeof data.categoriaPadreId === 'string'
    )
      entrada.categoriaPadreId = data.categoriaPadreId;
    if (data.orden === null || typeof data.orden === 'number')
      entrada.orden = data.orden;
    if (data.imagenUrl === null || typeof data.imagenUrl === 'string')
      entrada.imagenUrl = data.imagenUrl;
    if (data.version === null || typeof data.version === 'number')
      entrada.version = data.version;
    const result = await this.actualizarCategorias.actualizar(
      id,
      entrada,
      correlationId,
    );
    if (result.estado === 'NO_ENCONTRADA')
      throw new ProblemDetailsException({
        type: '/errores/categoria-no-encontrada',
        title: 'Categoría no encontrada',
        status: 404,
        code: 'CATEGORIA_NO_ENCONTRADA',
      });
    if (result.estado === 'PADRE_INVALIDO')
      throw ProblemDetailsException.validacion(
        'Categoría padre no encontrada.',
      );
    if (result.estado === 'PADRE_INACTIVO')
      throw new ProblemDetailsException({
        type: '/errores/categoria-padre-inactiva',
        title: 'Categoría padre inactiva',
        status: 409,
        code: 'CATEGORIA_PADRE_INACTIVA',
      });
    if (result.estado === 'CICLO')
      throw new ProblemDetailsException({
        type: '/errores/ciclo-categoria',
        title: 'Ciclo de categoría',
        status: 409,
        code: 'CICLO_CATEGORIA',
      });
    if (result.estado === 'VERSION_CONFLICT')
      throw new ProblemDetailsException({
        type: '/errores/version-conflict',
        title: 'Conflicto de versión',
        status: 409,
        code: 'VERSION_CONFLICT',
      });
    if (result.estado === 'PROFUNDIDAD')
      throw new ProblemDetailsException({
        type: '/errores/profundidad-categoria-excedida',
        title: 'Profundidad excedida',
        status: 422,
        code: 'PROFUNDIDAD_CATEGORIA_EXCEDIDA',
      });
    if (result.estado !== 'OK') throw ProblemDetailsException.noDisponible();
    return result.categoria;
  }

  private entradaMarca(
    body: unknown,
    file:
      { buffer: Buffer; originalname: string; mimetype: string } | undefined,
    crear: boolean,
  ): EntradaMarca {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw ProblemDetailsException.validacion('Formulario inválido.');
    const input = body as Record<string, unknown>;
    if (
      (crear && (typeof input.nombre !== 'string' || !input.nombre.trim())) ||
      (input.nombre !== undefined &&
        (typeof input.nombre !== 'string' || !input.nombre.trim())) ||
      (input.descripcion != null && typeof input.descripcion !== 'string') ||
      (input.paisOrigenIso != null &&
        (typeof input.paisOrigenIso !== 'string' ||
          (input.paisOrigenIso !== '' && !esPaisIso(input.paisOrigenIso)))) ||
      (input.version != null &&
        (typeof input.version !== 'string' ||
          !/^\d+$/.test(input.version) ||
          !Number.isSafeInteger(Number(input.version))))
    )
      throw ProblemDetailsException.validacion('Datos de marca inválidos.');
    if (crear || file) validarLogo(file);
    if (
      input.logo !== undefined &&
      ((input.logo !== '' && input.logo !== null) || crear || file)
    )
      throw ProblemDetailsException.validacion('Campo logo inválido.');
    const url = input.logoUrl ?? input.logo_url;
    if (url !== undefined && (typeof url !== 'string' || !url.trim()))
      throw ProblemDetailsException.validacion('logoUrl inválida.');
    let logoUrl: string | null | undefined;
    if (typeof url === 'string') {
      try {
        const parsed = new URL(url);
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        )
          throw new Error();
        logoUrl = parsed.toString();
      } catch {
        throw ProblemDetailsException.validacion(
          'logoUrl debe ser una URL HTTP(S) válida.',
        );
      }
    } else if (
      (crear && file) ||
      (!crear && (input.logo === '' || input.logo === null || file))
    )
      logoUrl = null;
    return {
      ...(typeof input.nombre === 'string' ? { nombre: input.nombre } : {}),
      ...(typeof input.descripcion === 'string' || input.descripcion === null
        ? { descripcion: input.descripcion === '' ? null : input.descripcion }
        : {}),
      ...(typeof input.paisOrigenIso === 'string' ||
      input.paisOrigenIso === null
        ? {
            paisOrigenIso:
              input.paisOrigenIso === '' ? null : input.paisOrigenIso,
          }
        : {}),
      ...(typeof input.version === 'string'
        ? { version: Number(input.version) }
        : {}),
      ...(logoUrl !== undefined ? { logoUrl } : {}),
    };
  }

  @Post('marcas')
  @UseGuards(TaxonomyCommercialGuard)
  @UseInterceptors(
    FileInterceptor('logo', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8, parts: 9 },
    }),
  )
  async crearMarca(
    @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @UploadedFile()
    file:
      { buffer: Buffer; originalname: string; mimetype: string } | undefined,
  ) {
    if (!contentType || !/^multipart\/form-data(?:;|$)/i.test(contentType))
      throw ProblemDetailsException.validacion(
        'Se requiere multipart/form-data.',
      );
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion(
        'X-Correlation-Id debe ser un UUID válido.',
      );
    const data = this.entradaMarca(body, file, true);
    const result = await this.marcas.crear(data);
    if (result.estado === 'DUPLICADA')
      throw new ProblemDetailsException({
        type: '/errores/marca-duplicada',
        title: 'Marca duplicada',
        status: 409,
        code: 'MARCA_DUPLICADA',
      });
    if (result.estado !== 'OK') throw ProblemDetailsException.noDisponible();
    return result.marca;
  }

  @Patch('marcas/:marcaId')
  @UseGuards(TaxonomyCommercialGuard)
  @UseInterceptors(
    FileInterceptor('logo', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8, parts: 9 },
    }),
  )
  async actualizarMarca(
    @Param('marcaId') id: string,
    @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @UploadedFile()
    file:
      { buffer: Buffer; originalname: string; mimetype: string } | undefined,
  ) {
    if (!contentType || !/^multipart\/form-data(?:;|$)/i.test(contentType))
      throw ProblemDetailsException.validacion(
        'Se requiere multipart/form-data.',
      );
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion(
        'X-Correlation-Id debe ser un UUID válido.',
      );
    const data = this.entradaMarca(body, file, false);
    const result = await this.marcas.actualizar(id, data);
    if (result.estado === 'NO_ENCONTRADA')
      throw new ProblemDetailsException({
        type: '/errores/marca-no-encontrada',
        title: 'Marca no encontrada',
        status: 404,
        code: 'MARCA_NO_ENCONTRADA',
      });
    if (result.estado === 'DUPLICADA')
      throw new ProblemDetailsException({
        type: '/errores/marca-duplicada',
        title: 'Marca duplicada',
        status: 409,
        code: 'MARCA_DUPLICADA',
      });
    if (result.estado === 'VERSION_CONFLICT')
      throw new ProblemDetailsException({
        type: '/errores/version-conflict',
        title: 'Conflicto de versión',
        status: 409,
        code: 'VERSION_CONFLICT',
      });
    if (result.estado !== 'OK') throw ProblemDetailsException.noDisponible();
    return result.marca;
  }

  @Post('categorias')
  @UseGuards(TaxonomyCommercialGuard)
  async crearCategoria(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion(
        'X-Correlation-Id debe ser un UUID válido.',
      );
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw ProblemDetailsException.validacion('Cuerpo inválido.');
    const data = body as Record<string, unknown>;
    if (
      typeof data.nombre !== 'string' ||
      !data.nombre.trim() ||
      typeof data.slugConfirmado !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slugConfirmado) ||
      (data.descripcion != null && typeof data.descripcion !== 'string') ||
      (data.categoriaPadreId != null && !esUuid(data.categoriaPadreId)) ||
      (data.orden != null &&
        (typeof data.orden !== 'number' ||
          !Number.isSafeInteger(data.orden) ||
          data.orden < 0)) ||
      (data.imagenUrl != null && typeof data.imagenUrl !== 'string') ||
      (data.version != null &&
        (typeof data.version !== 'number' ||
          !Number.isSafeInteger(data.version) ||
          data.version < 0))
    )
      throw ProblemDetailsException.validacion('Datos de categoría inválidos.');
    if (typeof data.imagenUrl === 'string') {
      try {
        new URL(data.imagenUrl);
      } catch {
        throw ProblemDetailsException.validacion(
          'imagenUrl debe ser una URI válida.',
        );
      }
    }
    const result = await this.crearCategorias.crear(
      {
        nombre: data.nombre,
        descripcion:
          typeof data.descripcion === 'string' ? data.descripcion : null,
        categoriaPadreId:
          typeof data.categoriaPadreId === 'string'
            ? data.categoriaPadreId
            : null,
        orden: typeof data.orden === 'number' ? data.orden : 0,
        imagenUrl: typeof data.imagenUrl === 'string' ? data.imagenUrl : null,
        slugConfirmado: data.slugConfirmado,
      },
      correlationId,
    );
    if (result.estado === 'PADRE_INVALIDO')
      throw ProblemDetailsException.validacion(
        'Categoría padre no encontrada.',
      );
    if (result.estado === 'PADRE_INACTIVO')
      throw new ProblemDetailsException({
        type: '/errores/categoria-padre-inactiva',
        title: 'Categoría padre inactiva',
        status: 409,
        code: 'CATEGORIA_PADRE_INACTIVA',
      });
    if (result.estado === 'PROFUNDIDAD_EXCEDIDA')
      throw new ProblemDetailsException({
        type: '/errores/profundidad-categoria-excedida',
        title: 'Profundidad excedida',
        status: 422,
        code: 'PROFUNDIDAD_CATEGORIA_EXCEDIDA',
      });
    if (result.estado === 'SLUG_DUPLICADO')
      throw new ProblemDetailsException({
        type: '/errores/slug-duplicado',
        title: 'Slug duplicado',
        status: 409,
        code: 'SLUG_DUPLICADO',
      });
    if (result.estado !== 'CREADA')
      throw ProblemDetailsException.noDisponible();
    return result.categoria;
  }

  @Post('marcas/:marcaId/reactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(200)
  async reactivarMarca(
    @Param('marcaId') marcaId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion(
        'X-Correlation-Id debe ser un UUID válido.',
      );
    const result = await this.reactivacion.reactivar(marcaId);
    if (result.estado === 'NO_ENCONTRADA')
      throw new ProblemDetailsException({
        type: '/errores/marca-no-encontrada',
        title: 'Marca no encontrada',
        status: 404,
        code: 'MARCA_NO_ENCONTRADA',
      });
    if (result.estado === 'BAJA_EN_PROCESO')
      throw ProblemDetailsException.noDisponible(
        'La baja maestra está en proceso.',
      );
    return result.marca;
  }

  @Post('categorias/:categoriaId/desactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(202)
  async solicitarDesactivacionCategoria(
    @Param('categoriaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!esUuid(id) || (correlationId !== undefined && !esUuid(correlationId)))
      throw ProblemDetailsException.validacion('Identificador inválido.');
    return this.solicitarBaja(
      { tipo: 'CATEGORY', id },
      correlationId,
      'CATEGORIA_NO_ENCONTRADA',
    );
  }

  @Post('marcas/:marcaId/desactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(202)
  async solicitarDesactivacionMarca(
    @Param('marcaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!esUuid(id) || (correlationId !== undefined && !esUuid(correlationId)))
      throw ProblemDetailsException.validacion('Identificador inválido.');
    return this.solicitarBaja(
      { tipo: 'BRAND', id },
      correlationId,
      'MARCA_NO_ENCONTRADA',
    );
  }

  private async solicitarBaja(
    solicitud: SolicitudMaestra,
    correlationId: string | undefined,
    codigoNoEncontrado: 'CATEGORIA_NO_ENCONTRADA' | 'MARCA_NO_ENCONTRADA',
  ) {
    const resultado = await this.bajas.solicitar(solicitud, correlationId);
    if (resultado.estado === 'CATEGORIA_CON_HIJOS')
      throw new ProblemDetailsException({
        type: '/errores/categoria-con-subcategorias-activas',
        title: 'Categoría con subcategorías activas',
        status: 409,
        code: 'CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS',
      });
    if (resultado.estado === 'NO_ENCONTRADA')
      throw new ProblemDetailsException({
        type: `/errores/${codigoNoEncontrado.toLowerCase().replace(/_/g, '-')}`,
        title: 'Recurso no encontrado',
        status: 404,
        code: codigoNoEncontrado,
      });
    if (resultado.estado === 'CONFLICTO')
      throw new ProblemDetailsException({
        type: '/errores/baja-maestra-en-proceso',
        title: 'Baja maestra en proceso',
        status: 409,
        code: 'BAJA_MAESTRA_EN_PROCESO',
      });
    return {
      operation_id: resultado.operation_id,
      correlation_id: resultado.correlation_id,
      status: resultado.status,
    };
  }

  @Post('categorias/:categoriaId/reactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(200)
  async reactivarCategoria(
    @Param('categoriaId') categoriaId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion(
        'X-Correlation-Id debe ser un UUID válido.',
      );
    const result = await this.categorias.reactivar(categoriaId, correlationId);
    if (result.estado === 'NO_ENCONTRADA')
      throw new ProblemDetailsException({
        type: '/errores/categoria-no-encontrada',
        title: 'Categoría no encontrada',
        status: 404,
        code: 'CATEGORIA_NO_ENCONTRADA',
      });
    if (result.estado === 'PADRE_INACTIVO')
      throw new ProblemDetailsException({
        type: '/errores/categoria-padre-inactiva',
        title: 'Categoría padre inactiva',
        status: 409,
        code: 'CATEGORIA_PADRE_INACTIVA',
      });
    if (result.estado === 'BAJA_EN_PROCESO')
      throw ProblemDetailsException.noDisponible(
        'La baja maestra está en proceso.',
      );
    return result.categoria;
  }
}
