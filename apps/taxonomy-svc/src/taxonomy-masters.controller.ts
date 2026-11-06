import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  TaxonomyUserGuard,
  TaxonomyCommercialGuard,
  AllowTaxonomyServiceRead,
  RequireTaxonomyCommercialUser,
} from './taxonomy-auth.js';
import { esUuid, ProblemDetailsException } from './errors/taxonomy.errors.js';
import { ProductTypeService } from './domain/product-type.service.js';
import { CharacteristicValueService } from './domain/characteristic-value.service.js';
import { ProductTypeCharacteristicService } from './domain/product-type-characteristic.service.js';
import { CharacteristicService } from './domain/characteristic.service.js';
import { DeactivationIntentService } from './domain/deactivation-intent.service.js';
import {
  MasterDeactivationRequestService,
  type SolicitudMaestra,
} from './domain/master-deactivation-request.service.js';
import {
  validarAsociacionCreate,
  validarAsociacionUpdate,
  validarTipoProductoCreate,
  validarValorCaracteristicaWrite,
} from './domain/entidades-maestras.dto.js';

function validarId(id: string): void {
  if (!esUuid(id))
    throw ProblemDetailsException.validacion('Identificador inválido.');
}
function validarCorrelacion(correlationId?: string): void {
  if (correlationId !== undefined && !esUuid(correlationId))
    throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
}
function estadoValido(estado?: string): string | undefined {
  if (estado !== undefined && !['ACTIVO', 'INACTIVO'].includes(estado))
    throw ProblemDetailsException.validacion('Estado inválido.');
  return estado;
}
function problema(status: number, code: string): ProblemDetailsException {
  return new ProblemDetailsException({
    type: `/errores/${code.toLowerCase().replace(/_/g, '-')}`,
    title:
      status === 404
        ? 'No encontrado'
        : status === 422
          ? 'Límite excedido'
          : 'Conflicto',
    status,
    code,
  });
}
function valorNumericoInvalido(): ProblemDetailsException {
  return new ProblemDetailsException({
    type: '/errores/valor-numerico-invalido',
    title: 'Valor numérico inválido',
    status: 422,
    code: 'VALOR_NUMERICO_INVALIDO',
  });
}

@Controller('api/v1')
@UseGuards(TaxonomyUserGuard)
export class TaxonomyMastersController {
  constructor(
    private readonly tipos: ProductTypeService,
    private readonly valores: CharacteristicValueService,
    private readonly asociaciones: ProductTypeCharacteristicService,
    private readonly bajas: MasterDeactivationRequestService,
    private readonly caracteristicas: CharacteristicService,
    private readonly intenciones: DeactivationIntentService,
  ) {}

  @Get('taxonomia/operaciones/:operationId')
  @RequireTaxonomyCommercialUser()
  async obtenerOperacionMaestra(
    @Param('operationId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const result = await this.intenciones.obtenerOperacion(id);
    if (!result) throw problema(404, 'OPERACION_MAESTRA_NO_ENCONTRADA');
    return result;
  }

  @Get('caracteristicas')
  @UseGuards(TaxonomyCommercialGuard)
  async listarCaracteristicas(
    @Query('pagina') paginaTexto?: string,
    @Query('tamanio') tamanioTexto?: string,
    @Query('estado') estado?: string,
    @Query('tipo') tipo?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarCorrelacion(correlationId);
    const pagina = paginaTexto === undefined ? 1 : Number(paginaTexto);
    const tamanio = tamanioTexto === undefined ? 20 : Number(tamanioTexto);
    if (
      !Number.isSafeInteger(pagina) ||
      pagina < 1 ||
      !Number.isSafeInteger(tamanio) ||
      tamanio < 1 ||
      tamanio > 200 ||
      (estado !== undefined && !['ACTIVO', 'INACTIVO'].includes(estado)) ||
      (tipo !== undefined && !['TEXTO', 'NUMERO', 'LISTA'].includes(tipo))
    )
      throw ProblemDetailsException.validacion(
        'Filtros de características inválidos.',
      );
    return this.caracteristicas.listar({ pagina, tamanio, estado, tipo });
  }

  @Post('caracteristicas')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(201)
  async crearCaracteristica(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarCorrelacion(correlationId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw ProblemDetailsException.validacion();
    const v = body as Record<string, unknown>;
    if (
      typeof v.nombre !== 'string' ||
      !v.nombre.trim() ||
      !['TEXTO', 'NUMERO', 'LISTA'].includes(String(v.tipo)) ||
      (v.unidadMedida !== undefined &&
        v.unidadMedida !== null &&
        typeof v.unidadMedida !== 'string') ||
      (v.tipo !== 'NUMERO' && v.unidadMedida != null)
    )
      throw ProblemDetailsException.validacion(
        'Datos de característica inválidos.',
      );
    if (
      v.tipo === 'NUMERO' &&
      (typeof v.unidadMedida !== 'string' || !v.unidadMedida.trim())
    )
      throw valorNumericoInvalido();
    const creada = await this.caracteristicas.crear({
      nombre: v.nombre,
      tipo: String(v.tipo),
      unidadMedida: v.unidadMedida as string | null | undefined,
    });
    if (!creada)
      throw ProblemDetailsException.validacion(
        'Característica fuera de los límites configurados.',
      );
    return creada;
  }

  @Get('caracteristicas/:caracteristicaId')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async obtenerCaracteristica(
    @Param('caracteristicaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const value = await this.caracteristicas.obtener(id);
    if (!value) throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    return value;
  }

  @Patch('caracteristicas/:caracteristicaId')
  @UseGuards(TaxonomyCommercialGuard)
  async actualizarCaracteristica(
    @Param('caracteristicaId') id: string,
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw ProblemDetailsException.validacion();
    const v = body as Record<string, unknown>;
    if (
      !Number.isSafeInteger(v.version) ||
      Number(v.version) < 0 ||
      (v.tipo !== undefined &&
        !['TEXTO', 'NUMERO', 'LISTA'].includes(String(v.tipo))) ||
      (v.nombre !== undefined &&
        (typeof v.nombre !== 'string' || !v.nombre.trim())) ||
      (v.unidadMedida !== undefined &&
        v.unidadMedida !== null &&
        typeof v.unidadMedida !== 'string')
    )
      throw ProblemDetailsException.validacion(
        'Datos de característica inválidos.',
      );
    const r = await this.caracteristicas.actualizar(id, {
      nombre: v.nombre as string | undefined,
      unidadMedida: v.unidadMedida as string | null | undefined,
      tipo: v.tipo as string | undefined,
      version: Number(v.version),
    });
    if (r === 'NO_ENCONTRADA')
      throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    if (r === 'VERSION_CONFLICT') throw problema(409, 'VERSION_CONFLICT');
    if (r === 'TIPO_CARACTERISTICA_INMUTABLE')
      throw problema(409, 'TIPO_CARACTERISTICA_INMUTABLE');
    if (r === 'NOMBRE_DUPLICADO')
      throw ProblemDetailsException.validacion(
        'Ya existe una característica con ese nombre.',
      );
    if (r === 'BAJA_EN_PROCESO') throw problema(409, 'VERSION_CONFLICT');
    if (r === 'UNIDAD_INCOMPATIBLE')
      throw ProblemDetailsException.validacion(
        'La unidad de medida solo aplica a características NUMERO.',
      );
    if (r === 'INVALIDA') throw valorNumericoInvalido();
    return r;
  }

  @Post('caracteristicas/:caracteristicaId/desactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(200)
  async desactivarCaracteristica(
    @Param('caracteristicaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const value = await this.caracteristicas.cambiarEstado(id, 'INACTIVO');
    if (value === 'BAJA_EN_PROCESO')
      throw problema(409, 'BAJA_MAESTRA_EN_PROCESO');
    if (!value) throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    return value;
  }

  @Post('caracteristicas/:caracteristicaId/reactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(200)
  async reactivarCaracteristica(
    @Param('caracteristicaId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const value = await this.caracteristicas.cambiarEstado(id, 'ACTIVO');
    if (value === 'BAJA_EN_PROCESO') throw problema(409, 'VERSION_CONFLICT');
    if (!value) throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    return value;
  }

  @Get('tipos-producto')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async listarTiposProducto(
    @Query('pagina') paginaTexto?: string,
    @Query('tamanio') tamanioTexto?: string,
    @Query('estado') estado?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarCorrelacion(correlationId);
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
    return this.tipos.listar(pagina, tamanio, estadoValido(estado));
  }

  @Get('tipos-producto/:tipoProductoId')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async obtenerTipoProducto(
    @Param('tipoProductoId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const tipo = await this.tipos.obtener(id);
    if (!tipo) throw problema(404, 'TIPO_PRODUCTO_NO_ENCONTRADO');
    if (tipo.estado === 'PENDING_DEACTIVATION')
      throw ProblemDetailsException.noDisponible(
        'El contrato TipoProductoAdmin no representa el estado pendiente de baja.',
      );
    return tipo;
  }

  @Post('tipos-producto')
  @UseGuards(TaxonomyCommercialGuard)
  async crearTipoProducto(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarCorrelacion(correlationId);
    const resultado = await this.tipos.crear(
      validarTipoProductoCreate(body).nombre,
    );
    if (!resultado)
      throw ProblemDetailsException.validacion('Tipo de producto duplicado.');
    return resultado;
  }

  @Get('caracteristicas/:caracteristicaId/valores')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async listarValoresCaracteristica(
    @Param('caracteristicaId') id: string,
    @Query('estado') estado?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const valores = await this.valores.listar(id, estadoValido(estado));
    if (!valores) throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    return valores;
  }

  @Post('caracteristicas/:caracteristicaId/valores')
  @UseGuards(TaxonomyCommercialGuard)
  async crearValorCaracteristica(
    @Param('caracteristicaId') id: string,
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const resultado = await this.valores.crear(
      id,
      validarValorCaracteristicaWrite(body).nombre,
    );
    if (resultado.estado === 'NO_ENCONTRADA')
      throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    if (resultado.estado === 'LIMITE')
      throw problema(422, 'VALOR_LISTA_LIMITE_EXCEDIDO');
    if (resultado.estado === 'INVALIDO')
      throw ProblemDetailsException.validacion('No se pudo crear el valor.');
    return resultado.valor;
  }

  @Patch('caracteristicas/:caracteristicaId/valores/:valorId')
  @UseGuards(TaxonomyCommercialGuard)
  async actualizarValorCaracteristica(
    @Param('caracteristicaId') caracteristicaId: string,
    @Param('valorId') id: string,
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(caracteristicaId);
    validarId(id);
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const dto = validarValorCaracteristicaWrite(body);
    const resultado = await this.valores.actualizar(
      caracteristicaId,
      id,
      dto.nombre,
      dto.version,
      correlationId,
    );
    if (resultado.estado === 'NO_ENCONTRADA')
      throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    if (resultado.estado === 'VERSION_CONFLICT')
      throw problema(409, 'VERSION_CONFLICT');
    if (resultado.estado === 'INVALIDO')
      throw ProblemDetailsException.validacion(
        'No se pudo actualizar el valor.',
      );
    return resultado.valor;
  }

  @Post('caracteristicas/:caracteristicaId/valores/:valorId/reactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(200)
  async reactivarValorCaracteristica(
    @Param('caracteristicaId') caracteristicaId: string,
    @Param('valorId') valorId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(caracteristicaId);
    validarId(valorId);
    validarCorrelacion(correlationId);
    const result = await this.valores.reactivar(caracteristicaId, valorId);
    if (!result) throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    return result;
  }

  @Get('tipos-producto/:tipoProductoId/caracteristicas')
  @AllowTaxonomyServiceRead()
  @RequireTaxonomyCommercialUser()
  async obtenerEsquemaTipoProducto(
    @Param('tipoProductoId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarCorrelacion(correlationId);
    const esquema = await this.tipos.obtenerEsquema(id);
    if (!esquema) throw problema(404, 'TIPO_PRODUCTO_NO_ENCONTRADO');
    if (esquema.tipoProducto.estado === 'PENDING_DEACTIVATION')
      throw ProblemDetailsException.noDisponible(
        'El contrato TipoProductoAdmin no representa el estado pendiente de baja.',
      );
    return esquema;
  }

  @Post('tipos-producto/:tipoProductoId/caracteristicas')
  @UseGuards(TaxonomyCommercialGuard)
  async asociarCaracteristicaTipoProducto(
    @Param('tipoProductoId') id: string,
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const dto = validarAsociacionCreate(body);
    validarId(dto.caracteristicaId);
    const resultado = await this.asociaciones.crear(
      id,
      dto.caracteristicaId,
      dto.obligatoria,
      dto.schemaVersion,
      correlationId,
    );
    if (resultado.estado === 'TIPO_AUSENTE')
      throw problema(404, 'TIPO_PRODUCTO_NO_ENCONTRADO');
    if (resultado.estado === 'CARACTERISTICA_AUSENTE')
      throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    if (resultado.estado === 'LIMITE')
      throw problema(422, 'LIMITE_CARACTERISTICAS_EXCEDIDO');
    if (resultado.estado !== 'OK') throw problema(409, resultado.estado);
    return resultado.asociacion;
  }

  @Patch('tipos-producto/:tipoProductoId/caracteristicas/:caracteristicaId')
  @UseGuards(TaxonomyCommercialGuard)
  async actualizarAsociacionTipoCaracteristica(
    @Param('tipoProductoId') tipoId: string,
    @Param('caracteristicaId') caracteristicaId: string,
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(tipoId);
    validarId(caracteristicaId);
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const dto = validarAsociacionUpdate(body);
    const resultado = await this.asociaciones.actualizar(
      tipoId,
      caracteristicaId,
      dto.obligatoria,
      dto.schemaVersion,
      correlationId,
    );
    if (resultado.estado === 'TIPO_AUSENTE')
      throw problema(404, 'TIPO_PRODUCTO_NO_ENCONTRADO');
    if (resultado.estado === 'ASOCIACION_AUSENTE')
      throw problema(404, 'ASOCIACION_NO_ENCONTRADA');
    if (resultado.estado !== 'OK') throw problema(409, resultado.estado);
    return resultado.asociacion;
  }

  private async solicitar(solicitud: SolicitudMaestra, correlationId?: string) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const resultado = await this.bajas.solicitar(solicitud, correlationId);
    if (resultado.estado === 'CATEGORIA_CON_HIJOS')
      throw problema(409, 'CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS');
    if (resultado.estado === 'NO_ENCONTRADA')
      throw problema(
        404,
        solicitud.tipo === 'PRODUCT_TYPE'
          ? 'TIPO_PRODUCTO_NO_ENCONTRADO'
          : solicitud.tipo === 'CHARACTERISTIC_VALUE'
            ? 'CARACTERISTICA_NO_ENCONTRADA'
            : 'ASOCIACION_NO_ENCONTRADA',
      );
    if (resultado.estado === 'CONFLICTO')
      throw problema(409, 'BAJA_MAESTRA_EN_PROCESO');
    return {
      operation_id: resultado.operation_id,
      correlation_id: resultado.correlation_id,
      status: resultado.status,
    };
  }

  @Post('tipos-producto/:tipoProductoId/desactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(202)
  solicitarDesactivacionTipoProducto(
    @Param('tipoProductoId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    return this.solicitar({ tipo: 'PRODUCT_TYPE', id }, correlationId);
  }

  @Post('tipos-producto/:tipoProductoId/reactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(200)
  async reactivarTipoProducto(
    @Param('tipoProductoId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const result = await this.tipos.reactivar(id);
    if (result === 'NO_ENCONTRADO')
      throw problema(404, 'TIPO_PRODUCTO_NO_ENCONTRADO');
    if (result === 'BAJA_EN_PROCESO') throw problema(409, 'VERSION_CONFLICT');
    return result;
  }
  @Post('caracteristicas/:caracteristicaId/valores/:valorId/desactivar')
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(202)
  solicitarDesactivacionValorCaracteristica(
    @Param('caracteristicaId') caracteristicaId: string,
    @Param('valorId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    validarId(caracteristicaId);
    return this.solicitar(
      { tipo: 'CHARACTERISTIC_VALUE', id, caracteristicaId },
      correlationId,
    );
  }
  @Post(
    'tipos-producto/:tipoProductoId/caracteristicas/:caracteristicaId/desasociar',
  )
  @UseGuards(TaxonomyCommercialGuard)
  @HttpCode(202)
  solicitarDesasociacionTipoCaracteristica(
    @Param('tipoProductoId') tipoProductoId: string,
    @Param('caracteristicaId') caracteristicaId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(tipoProductoId);
    validarId(caracteristicaId);
    return this.solicitar(
      { tipo: 'PRODUCT_TYPE_CHARACTERISTIC', tipoProductoId, caracteristicaId },
      correlationId,
    );
  }
}
