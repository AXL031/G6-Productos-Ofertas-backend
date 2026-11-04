import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  type LoggerService,
} from '@nestjs/common';
import { ProblemDetailsException, esUuid } from './taxonomy.errors.js';
import type { ProblemDetailsBody } from './taxonomy.errors.js';

interface RespuestaHttp {
  status(codigo: number): RespuestaHttp;
  header(nombre: string, valor: string): RespuestaHttp;
  json(cuerpo: ProblemDetailsBody): unknown;
}

interface SolicitudHttp {
  headers: Record<string, unknown>;
}

const TITULOS_POR_ESTADO: Record<number, string | undefined> = {
  [HttpStatus.BAD_REQUEST]: 'Datos de entrada inválidos',
  [HttpStatus.UNAUTHORIZED]: 'No autenticado',
  [HttpStatus.FORBIDDEN]: 'No autorizado',
  [HttpStatus.NOT_FOUND]: 'No encontrado',
  [HttpStatus.CONFLICT]: 'Conflicto',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Servicio temporalmente no disponible',
};

const DETALLE_ERROR_INTERNO = 'Ha ocurrido un error interno en el servicio';

function codigoPorEstado(estado: number): string {
  switch (estado) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDACION';
    case HttpStatus.UNAUTHORIZED:
      return 'TOKEN_INVALIDO';
    case HttpStatus.FORBIDDEN:
      return 'SCOPE_INSUFICIENTE';
    case HttpStatus.NOT_FOUND:
      return 'NO_ENCONTRADO';
    case HttpStatus.CONFLICT:
      return 'CONFLICTO';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMIT_EXCEDIDO';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'LOGO_EXCEDE_LIMITE';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICIO_NO_DISPONIBLE';
    default:
      return estado >= 500 ? 'ERROR_INTERNO' : 'ERROR_HTTP';
  }
}

function tipoPorCodigo(codigo: string): string {
  return '/errores/' + codigo.toLowerCase().replace(/_/g, '-');
}

function solicitarCorrelacion(request: SolicitudHttp): string | undefined {
  const crudo =
    request.headers['x-correlation-id'] ?? request.headers['correlation-id'];
  return typeof crudo === 'string' && esUuid(crudo) ? crudo : undefined;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private logger: LoggerService = new Logger(ProblemDetailsFilter.name);

  /** Reemplazable en pruebas; en runtime usa el logger central de Nest. */
  usarLogger(logger: LoggerService): void {
    this.logger = logger;
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<RespuestaHttp>();
    const request = context.getRequest<SolicitudHttp>();
    const correlationId = solicitarCorrelacion(request);

    if (exception instanceof ProblemDetailsException) {
      const problem: ProblemDetailsBody = { ...exception.problem };
      if (!problem.correlationId && correlationId) {
        problem.correlationId = correlationId;
      }
      return response
        .status(problem.status)
        .header('Content-Type', 'application/problem+json')
        .json(problem);
    }

    if (exception instanceof HttpException && exception.getStatus() < 500) {
      const status = exception.getStatus();
      const code = codigoPorEstado(status);
      const problem: ProblemDetailsBody = {
        type: tipoPorCodigo(code),
        title: TITULOS_POR_ESTADO[status] ?? 'Error HTTP',
        status,
        code,
        detail: exception.message || undefined,
        correlationId,
      };
      return response
        .status(status)
        .header('Content-Type', 'application/problem+json')
        .json(problem);
    }

    // Los 5xx no contractuales conservan su estado, pero nunca su mensaje.
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = codigoPorEstado(status);
    this.logger.error({
      event: 'taxonomy.http.unexpected_error',
      service: 'taxonomy-svc',
      code,
      ...(correlationId ? { correlation_id: correlationId } : {}),
      status,
      category: 'UNEXPECTED_EXCEPTION',
    });
    const problem: ProblemDetailsBody = {
      type: tipoPorCodigo(code),
      title: TITULOS_POR_ESTADO[status] ?? 'Error interno',
      status,
      code,
      detail:
        status === HttpStatus.SERVICE_UNAVAILABLE
          ? 'Servicio temporalmente no disponible'
          : DETALLE_ERROR_INTERNO,
      correlationId,
    };
    return response
      .status(status)
      .header('Content-Type', 'application/problem+json')
      .json(problem);
  }
}
