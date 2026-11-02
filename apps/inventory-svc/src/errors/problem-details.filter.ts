import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import {
  ProblemDetailsException,
  ProblemDetailsBody,
} from './inventory.errors.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationIdHeader =
      (request.headers['x-correlation-id'] as string) ||
      (request.headers['correlation-id'] as string);

    if (exception instanceof ProblemDetailsException) {
      const problem = exception.problem;
      if (!problem.correlationId && correlationIdHeader) {
        problem.correlationId = correlationIdHeader;
      }
      return response
        .status(problem.status)
        .header('Content-Type', 'application/problem+json')
        .json(problem);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const detail =
        typeof res === 'string'
          ? res
          : typeof res === 'object' && res !== null && 'message' in res
            ? Array.isArray((res as { message: unknown }).message)
              ? (res as { message: string[] }).message.join('; ')
              : String((res as { message: unknown }).message)
            : exception.message;

      const code =
        status === HttpStatus.BAD_REQUEST
          ? 'VALIDACION'
          : status === HttpStatus.NOT_FOUND
            ? 'NO_ENCONTRADO'
            : status === HttpStatus.UNPROCESSABLE_ENTITY
              ? 'CANTIDAD_INVALIDA'
              : status === HttpStatus.CONFLICT
                ? 'CONFLICTO'
                : 'ERROR_HTTP';

      const body: ProblemDetailsBody = {
        type: `/errores/${code.toLowerCase().replace(/_/g, '-')}`,
        title: exception.name || 'Error',
        status,
        code,
        detail,
        correlationId: correlationIdHeader,
      };

      return response
        .status(status)
        .header('Content-Type', 'application/problem+json')
        .json(body);
    }

    // Errores técnicos nunca se reflejan al consumidor, incluso si no contienen
    // palabras SQL. Los códigos conocidos de indisponibilidad conservan el 503 contractual.
    const unavailable =
      exception instanceof Error &&
      'code' in exception &&
      typeof exception.code === 'string' &&
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        '08000',
        '08001',
        '08003',
        '08006',
        '57P01',
        '57P02',
        '57P03',
        '53300',
      ].includes(exception.code);

    const body: ProblemDetailsBody = {
      type: unavailable
        ? '/errores/servicio-no-disponible'
        : '/errores/error-interno',
      title: unavailable
        ? 'Servicio no disponible'
        : 'Error interno del servidor',
      status: unavailable
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.INTERNAL_SERVER_ERROR,
      code: unavailable ? 'SERVICIO_NO_DISPONIBLE' : 'ERROR_INTERNO',
      detail: unavailable
        ? 'Una dependencia del servicio no está disponible temporalmente'
        : 'Ha ocurrido un error interno en el servicio',
      correlationId: correlationIdHeader,
    };

    return response
      .status(body.status)
      .header('Content-Type', 'application/problem+json')
      .json(body);
  }
}
