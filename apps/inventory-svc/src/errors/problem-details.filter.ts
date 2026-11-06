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

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EPIPE',
  'ENETUNREACH',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '53400',
]);

const UNAVAILABLE_MESSAGES = [
  'connection terminated unexpectedly',
  'client was closed and is not queryable',
  'timeout exceeded when trying to connect',
  'terminating connection due to administrator command',
];

/**
 * Determina si una excepción corresponde a indisponibilidad o caída de base de datos/red.
 * Recorre recursivamente la propiedad `cause` para detectar errores de conexión envueltos
 * por DrizzleORM (DrizzleQueryError) u otros adaptadores.
 */
export function isDatabaseUnavailable(exception: unknown): boolean {
  let current: unknown = exception;
  let depth = 0;
  while (current && depth < 6) {
    if (typeof current === 'object' && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) {
        return true;
      }
      const message = (current as { message?: unknown }).message;
      if (
        typeof message === 'string' &&
        UNAVAILABLE_MESSAGES.some((msg) => message.toLowerCase().includes(msg))
      ) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
      depth++;
    } else {
      break;
    }
  }
  return false;
}

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
    // palabras SQL. Los códigos conocidos de indisponibilidad conservan el 503 contractual,
    // reconociendo fallos anidados en `cause` generados por DrizzleQueryError u otros wrappers.
    const unavailable = isDatabaseUnavailable(exception);

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
