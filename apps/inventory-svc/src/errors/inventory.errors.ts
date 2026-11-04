import { HttpException, HttpStatus } from '@nestjs/common';

export interface ProblemDetailsBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  correlationId?: string;
}

export class ProblemDetailsException extends HttpException {
  public readonly problem: ProblemDetailsBody;

  constructor(problem: ProblemDetailsBody) {
    super(problem, problem.status);
    this.problem = problem;
  }

  static validation(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/validacion',
      title: 'Datos de entrada inválidos',
      status: HttpStatus.BAD_REQUEST,
      code: 'VALIDACION',
      detail,
      correlationId,
    });
  }

  static cantidadInvalida(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/cantidad-invalida',
      title: 'Cantidad inválida',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'CANTIDAD_INVALIDA',
      detail,
      correlationId,
    });
  }

  static idempotencyConflict(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/idempotency-conflict',
      title: 'Conflicto de idempotencia',
      status: HttpStatus.CONFLICT,
      code: 'IDEMPOTENCY_CONFLICT',
      detail,
      correlationId,
    });
  }

  static reservaNoEncontrada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/reserva-no-encontrada',
      title: 'Reserva no encontrada',
      status: HttpStatus.NOT_FOUND,
      code: 'RESERVA_NO_ENCONTRADA',
      detail,
      correlationId,
    });
  }

  static reservaNoActiva(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/reserva-no-activa',
      title: 'Reserva no activa',
      status: HttpStatus.CONFLICT,
      code: 'RESERVA_NO_ACTIVA',
      detail,
      correlationId,
    });
  }

  static reservaExpirada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/reserva-expirada',
      title: 'Reserva expirada',
      status: HttpStatus.CONFLICT,
      code: 'RESERVA_EXPIRADA',
      detail,
      correlationId,
    });
  }

  static tokenInvalido(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/token-invalido',
      title: 'Token de autenticación ausente o inválido',
      status: HttpStatus.UNAUTHORIZED,
      code: 'TOKEN_INVALIDO',
      detail,
      correlationId,
    });
  }

  static scopeInsuficiente(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/scope-insuficiente',
      title: 'Scope o client_id no autorizado',
      status: HttpStatus.FORBIDDEN,
      code: 'SCOPE_INSUFICIENTE',
      detail,
      correlationId,
    });
  }

  static operacionNoEncontrada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/operacion-no-encontrada',
      title: 'Operación de inventario no encontrada',
      status: HttpStatus.NOT_FOUND,
      code: 'OPERACION_INVENTARIO_NO_ENCONTRADA',
      detail,
      correlationId,
    });
  }

  static contextoAbastecimientoInvalido(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/contexto-abastecimiento-invalido',
      title:
        'Contexto de abastecimiento o cumplimiento semánticamente inválido',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'CONTEXTO_ABASTECIMIENTO_INVALIDO',
      detail,
      correlationId,
    });
  }

  static reintegroNoAplicable(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/reintegro-no-aplicable',
      title: 'Reintegro no aplicable',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'REINTEGRO_NO_APLICABLE',
      detail,
      correlationId,
    });
  }

  static skuNoEncontrado(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/sku-no-encontrado',
      title: 'SKU no encontrado',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'SKU_NO_ENCONTRADO',
      detail,
      correlationId,
    });
  }

  /**
   * Variante 404 de SKU_NO_ENCONTRADO usada por la administración de umbrales
   * (OpenAPI `establecerUmbralSku`/`eliminarUmbralSku`), que declaran el código
   * con estado 404.
   */
  static skuNoEncontrado404(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/sku-no-encontrado',
      title: 'SKU no encontrado',
      status: HttpStatus.NOT_FOUND,
      code: 'SKU_NO_ENCONTRADO',
      detail,
      correlationId,
    });
  }

  static ubicacionNoEncontrada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/ubicacion-no-encontrada',
      title: 'Ubicación no encontrada',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'UBICACION_NO_ENCONTRADA',
      detail,
      correlationId,
    });
  }

  static skuInactivo(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/sku-inactivo',
      title: 'SKU inactivo',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'SKU_INACTIVO',
      detail,
      correlationId,
    });
  }

  static stockInsuficiente(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/stock-insuficiente',
      title: 'Stock insuficiente',
      status: HttpStatus.CONFLICT,
      code: 'STOCK_INSUFICIENTE',
      detail,
      correlationId,
    });
  }

  static incidenciaNoEncontrada(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/incidencia-no-encontrada',
      title: 'Incidencia de inventario no encontrada',
      status: HttpStatus.NOT_FOUND,
      code: 'INCIDENCIA_NO_ENCONTRADA',
      detail,
      correlationId,
    });
  }

  static incidenciaNoActiva(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/incidencia-no-activa',
      title: 'Incidencia no activa',
      status: HttpStatus.CONFLICT,
      code: 'INCIDENCIA_NO_ACTIVA',
      detail,
      correlationId,
    });
  }

  static resolucionIncidenciaInvalida(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/resolucion-incidencia-invalida',
      title: 'Resolución de incidencia inválida',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'RESOLUCION_INCIDENCIA_INVALIDA',
      detail,
      correlationId,
    });
  }

  static trasladoNoEncontrado(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/traslado-no-encontrado',
      title: 'Traslado de inventario no encontrado',
      status: HttpStatus.NOT_FOUND,
      code: 'TRASLADO_NO_ENCONTRADO',
      detail,
      correlationId,
    });
  }

  static trasladoNoRecibible(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/traslado-no-recibible',
      title: 'Traslado no recibible',
      status: HttpStatus.CONFLICT,
      code: 'TRASLADO_NO_RECIBIBLE',
      detail,
      correlationId,
    });
  }

  static cantidadRecibidaExcedeTraslado(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/cantidad-recibida-excede-traslado',
      title: 'Cantidad recibida excede el traslado',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'CANTIDAD_RECIBIDA_EXCEDE_TRASLADO',
      detail,
      correlationId,
    });
  }

  static disposicionRecepcionInvalida(
    detail?: string,
    correlationId?: string,
  ): ProblemDetailsException {
    return new ProblemDetailsException({
      type: '/errores/disposicion-recepcion-invalida',
      title: 'Disposición de recepción inválida',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'DISPOSICION_RECEPCION_INVALIDA',
      detail,
      correlationId,
    });
  }
}
