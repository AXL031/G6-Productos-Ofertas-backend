import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BulkDomainError } from '../domain/bulk.domain-error.js';

@Catch()
export class BulkProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    let status = 500;
    let code = 'ERROR_INTERNO';
    let detail = 'No se pudo completar la operación.';
    if (error instanceof BulkDomainError) {
      const mapped: Record<string, [number, string]> = {
        INVALID_INPUT: [400, 'VALIDACION'],
        ARCHIVO_INVALIDO: [400, 'ARCHIVO_INVALIDO'],
        ARCHIVO_EXCEDE_LIMITE: [413, 'ARCHIVO_EXCEDE_LIMITE'],
        PLANTILLA_INCOMPATIBLE: [422, 'PLANTILLA_INCOMPATIBLE'],
        CONTENIDO_ACTIVO_NO_PERMITIDO: [422, 'CONTENIDO_ACTIVO_NO_PERMITIDO'],
        IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_CONFLICT'],
        INVALID_TRANSITION: [409, 'IDEMPOTENCY_CONFLICT'],
        BATCH_NOT_FOUND: [404, 'LOTE_NO_ENCONTRADO'],
        EXPORT_NOT_FOUND: [404, 'LOTE_NO_ENCONTRADO'],
        EXPORT_NOT_READY: [503, 'SERVICIO_NO_DISPONIBLE'],
        STORAGE_UNAVAILABLE: [503, 'SERVICIO_NO_DISPONIBLE'],
        PERSISTENCE_FAILURE: [503, 'SERVICIO_NO_DISPONIBLE'],
        DEPENDENCY_PENDING: [503, 'SERVICIO_NO_DISPONIBLE'],
      };
      [status, code] = mapped[error.code] ?? [400, 'ARCHIVO_INVALIDO'];
      detail = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const body = error.getResponse();
      const message =
        typeof body === 'string' ? body : Reflect.get(body, 'message');
      if (status === 401) code = 'TOKEN_INVALIDO';
      else if (status === 403) code = 'SCOPE_INSUFICIENTE';
      else if (status === 413) code = 'ARCHIVO_EXCEDE_LIMITE';
      else if (
        typeof message === 'string' &&
        ['ARCHIVO_INVALIDO', 'PLANTILLA_INCOMPATIBLE', 'VALIDACION'].includes(
          message,
        )
      )
        code = message;
      if (status < 500 && typeof message === 'string') detail = message;
    } else if (
      error &&
      typeof error === 'object' &&
      typeof Reflect.get(error, 'code') === 'string' &&
      String(Reflect.get(error, 'code')).startsWith('LIMIT_')
    ) {
      const multerCode = String(Reflect.get(error, 'code'));
      status = multerCode === 'LIMIT_FILE_SIZE' ? 413 : 400;
      code =
        multerCode === 'LIMIT_FILE_SIZE'
          ? 'ARCHIVO_EXCEDE_LIMITE'
          : 'ARCHIVO_INVALIDO';
      detail =
        multerCode === 'LIMIT_FILE_SIZE'
          ? 'El archivo supera 10 485 760 bytes.'
          : 'La estructura multipart no coincide con el contrato.';
    }
    const correlationId = request.headers['x-correlation-id'];
    const validation = code === 'VALIDACION';
    response
      .status(status)
      .type('application/problem+json')
      .json({
        type: validation ? '/errores/validacion' : 'about:blank',
        title: validation ? 'Datos de entrada inválidos' : code,
        status,
        code,
        detail,
        instance: request.path,
        ...(typeof correlationId === 'string' ? { correlationId } : {}),
      });
  }
}
