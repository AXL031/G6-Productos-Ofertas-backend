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
      code =
        status === 400
          ? 'VALIDACION'
          : status === 404
            ? 'COMBO_NO_ENCONTRADO'
            : status === 503
              ? 'SERVICIO_NO_DISPONIBLE'
              : 'ERROR_INTERNO';
      title = status === 400 ? 'Datos de entrada inválidos' : title;
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
