import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TaxonomyUserGuard } from './taxonomy-auth.js';
import { esUuid, ProblemDetailsException } from './errors/taxonomy.errors.js';
import { ProductTypeService } from './domain/product-type.service.js';
import { CharacteristicValueService } from './domain/characteristic-value.service.js';
import { ProductTypeCharacteristicService } from './domain/product-type-characteristic.service.js';
import {
  MasterDeactivationRequestService,
  type SolicitudMaestra,
} from './domain/master-deactivation-request.service.js';
import {
  validarAsociacionCreate,
  validarTipoProductoCreate,
  validarValorCaracteristicaWrite,
} from './domain/entidades-maestras.dto.js';

function validarId(id: string): void {
  if (!esUuid(id))
    throw ProblemDetailsException.validacion('Identificador inválido.');
}
function estadoValido(estado?: string): string | undefined {
  if (
    estado !== undefined &&
    !['ACTIVO', 'INACTIVO', 'PENDING_DEACTIVATION'].includes(estado)
  )
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

@Controller('api/v1')
@UseGuards(TaxonomyUserGuard)
export class TaxonomyMastersController {
  constructor(
    private readonly tipos: ProductTypeService,
    private readonly valores: CharacteristicValueService,
    private readonly asociaciones: ProductTypeCharacteristicService,
    private readonly bajas: MasterDeactivationRequestService,
  ) {}

  @Get('tipos-producto')
  async listarTiposProducto(
    @Query('pagina') paginaTexto?: string,
    @Query('tamanio') tamanioTexto?: string,
    @Query('estado') estado?: string,
  ) {
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
  async obtenerTipoProducto(@Param('tipoProductoId') id: string) {
    validarId(id);
    const tipo = await this.tipos.obtener(id);
    if (!tipo) throw problema(404, 'TIPO_PRODUCTO_NO_ENCONTRADO');
    return tipo;
  }

  @Post('tipos-producto')
  async crearTipoProducto(@Body() body: unknown) {
    const resultado = await this.tipos.crear(
      validarTipoProductoCreate(body).nombre,
    );
    if (!resultado)
      throw ProblemDetailsException.validacion('Tipo de producto duplicado.');
    return resultado;
  }

  @Get('caracteristicas/:caracteristicaId/valores')
  async listarValoresCaracteristica(
    @Param('caracteristicaId') id: string,
    @Query('estado') estado?: string,
  ) {
    validarId(id);
    const valores = await this.valores.listar(id, estadoValido(estado));
    if (!valores) throw problema(404, 'CARACTERISTICA_NO_ENCONTRADA');
    return valores;
  }

  @Post('caracteristicas/:caracteristicaId/valores')
  async crearValorCaracteristica(
    @Param('caracteristicaId') id: string,
    @Body() body: unknown,
  ) {
    validarId(id);
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

  @Get('tipos-producto/:tipoProductoId/caracteristicas')
  async obtenerEsquemaTipoProducto(@Param('tipoProductoId') id: string) {
    validarId(id);
    const tipoProducto = await this.tipos.obtener(id);
    if (!tipoProducto) throw problema(404, 'TIPO_PRODUCTO_NO_ENCONTRADO');
    return {
      tipoProducto,
      caracteristicas: await this.asociaciones.listar(id),
      schemaVersion: tipoProducto.schemaVersion,
    };
  }

  @Post('tipos-producto/:tipoProductoId/caracteristicas')
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

  private async solicitar(solicitud: SolicitudMaestra, correlationId?: string) {
    if (correlationId !== undefined && !esUuid(correlationId))
      throw ProblemDetailsException.validacion('X-Correlation-Id inválido.');
    const resultado = await this.bajas.solicitar(solicitud, correlationId);
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
  @HttpCode(202)
  solicitarDesactivacionTipoProducto(
    @Param('tipoProductoId') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validarId(id);
    return this.solicitar({ tipo: 'PRODUCT_TYPE', id }, correlationId);
  }
  @Post('caracteristicas/:caracteristicaId/valores/:valorId/desactivar')
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
