import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { PricingPersistenceError } from '../persistence/persistence.error.js';
import { PriceRuleError, type PriceErrorCode } from '../domain/price.js';

const ruleStatus: Record<PriceErrorCode, number> = {
  PRECIO_INVALIDO: 422,
  OFERTA_INVALIDA: 422,
  ACCION_OFERTA_INVALIDA: 422,
  SCOPE_PRECIO_INVALIDO: 422,
  VALIDACION: 400,
  MOTIVO_CAMBIO_REQUERIDO: 400,
  PRECIO_NO_ENCONTRADO: 404,
  VERSION_CONFLICT: 409,
  VIGENCIA_SUPERPUESTA: 409,
  IDEMPOTENCY_CONFLICT: 409,
};

export class PricingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

@Catch()
export class PricingHttpFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const failure =
      error instanceof PricingHttpError
        ? error
        : error instanceof PricingPersistenceError
          ? new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE')
          : error instanceof PriceRuleError
            ? new PricingHttpError(ruleStatus[error.code], error.code)
            : new PricingHttpError(500, 'ERROR_INTERNO');
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
