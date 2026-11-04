import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

export class AuditHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export class AuditPersistenceError extends Error {
  constructor() {
    super('Persistencia de auditoría no disponible.');
  }
}
@Catch()
export class AuditHttpFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const failure =
      error instanceof AuditHttpError
        ? error
        : error instanceof AuditPersistenceError
          ? new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE')
          : error instanceof HttpException && error.getStatus() === 400
            ? new AuditHttpError(400, 'VALIDACION')
            : new AuditHttpError(500, 'ERROR_INTERNO');
    response
      .status(failure.status)
      .type('application/problem+json')
      .json({
        title: failure.code,
        status: failure.status,
        code: failure.code,
        correlationId: response.getHeader('X-Correlation-Id'),
      });
  }
}
