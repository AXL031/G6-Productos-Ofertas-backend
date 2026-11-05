import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ComboError } from '../combos-svc.service.js';

@Catch()
export class CombosProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const correlationId =
      req.header('X-Correlation-Id')?.trim() || randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);
    let status = 500;
    let code = 'ERROR_INTERNO';
    let title = 'Error interno';
    if (error instanceof ComboError) {
      status = error.status;
      code = error.code;
      title = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const response = error.getResponse();
      const responseCode =
        typeof response === 'object' && response !== null && 'code' in response
          ? response.code
          : undefined;
      code =
        typeof responseCode === 'string' &&
        /^[A-Z0-9_]{1,64}$/.test(responseCode)
          ? responseCode
          : status === 400
            ? 'VALIDACION'
            : status === 401
              ? 'TOKEN_INVALIDO'
              : status === 403
                ? 'SCOPE_INSUFICIENTE'
                : status === 404
                  ? 'COMBO_NO_ENCONTRADO'
                  : status === 409
                    ? 'VERSION_CONFLICT'
                    : status === 422
                      ? 'VALIDACION'
                      : status === 503
                        ? 'SERVICIO_NO_DISPONIBLE'
                        : 'ERROR_INTERNO';
      title =
        status === 400 || status === 422
          ? 'Datos de entrada inválidos'
          : status === 401
            ? 'Autenticación requerida o inválida'
            : status === 403
              ? 'Permiso insuficiente'
              : status === 404
                ? 'Recurso no encontrado'
                : status === 409
                  ? 'Conflicto de versión'
                  : status === 503
                    ? 'Servicio temporalmente no disponible'
                    : title;
    }
    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: `/errores/${code.toLowerCase()}`,
        title,
        status,
        code,
        correlationId,
      });
  }
}
