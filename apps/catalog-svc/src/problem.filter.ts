import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { correlationId, isCorrelationId } from './correlation.js';
import { CatalogPersistenceError } from './database-errors.js';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const databaseUnavailable =
      error instanceof CatalogPersistenceError &&
      error.failure === 'connection';
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : databaseUnavailable
          ? 503
          : 500;
    const body =
      error instanceof HttpException ? error.getResponse() : undefined;
    const supplied =
      body !== null && typeof body === 'object' && 'code' in body
        ? body.code
        : undefined;
    const code =
      status === 401
        ? 'TOKEN_INVALIDO'
        : status === 403
          ? 'SCOPE_INSUFICIENTE'
          : status === 404
            ? [
                'PRODUCTO_NO_ENCONTRADO',
                'VARIANTE_NO_ENCONTRADA',
                'CODIGO_BARRAS_NO_ENCONTRADO',
                'SKU_NO_ENCONTRADO',
              ].includes(String(supplied))
              ? String(supplied)
              : 'PRODUCTO_NO_ENCONTRADO'
            : status === 409 &&
                [
                  'SKU_DUPLICADO',
                  'COMBINACION_DUPLICADA',
                  'PRODUCTO_NO_ADMITE_VARIANTES',
                  'CAMBIO_ESTRUCTURAL_NO_PERMITIDO',
                  'VERSION_CONFLICT',
                  'IDEMPOTENCY_CONFLICT',
                  'PREPARACION_NO_REINTENTABLE',
                ].includes(String(supplied))
              ? String(supplied)
              : status === 422 &&
                  [
                    'CATEGORIA_INVALIDA',
                    'MARCA_INVALIDA',
                    'SKU_INVALIDO',
                    'TIPO_PRODUCTO_INVALIDO',
                    'PERFIL_FISICO_INVALIDO',
                    'DATOS_INCOMPLETOS',
                    'DATOS_FISICOS_INCOMPLETOS',
                    'ATRIBUTO_IDENTIFICADOR_INVALIDO',
                    'IMAGEN_INVALIDA',
                  ].includes(String(supplied))
                ? String(supplied)
                : status === 400
                  ? 'VALIDACION'
                  : status === 503
                    ? 'SERVICIO_NO_DISPONIBLE'
                    : 'ERROR_INTERNO';
    const established = response.getHeader('X-Correlation-Id');
    const id = correlationId(
      isCorrelationId(established)
        ? established
        : request.headers['x-correlation-id'],
    );
    request.headers['x-correlation-id'] = id;
    response
      .status(status)
      .type('application/problem+json')
      .set('X-Correlation-Id', id)
      .json({
        type: '/errores/' + code.toLowerCase().replaceAll('_', '-'),
        title: code,
        status,
        code,
        correlationId: id,
      });
  }
}
