import {
  ArgumentsHost,
  Catch,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  UseGuards,
  type ExceptionFilter,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  CommercialDependencyError,
  CommercialInputError,
} from '../domain/commercial-context.js';
import { PromotionsPersistenceError } from '../infrastructure/persistence/promotions-persistence.js';
import { PromotionsQueryGuard, QueryOperation } from './promotions-identity.js';
import { PromotionsQueryService } from './query-service.js';
import { httpContracts } from './http-contract.generated.js';
import { correlationId, PromotionsHttpError } from './http-validation.js';
import {
  PROMOTIONS_OPERATION_LOGGER,
  PromotionsOperationLogger,
} from '../infrastructure/logging/operation-logger.js';
import { requestElapsed } from './observation-interceptor.js';

const operationsBySpecificity = Object.entries(httpContracts).sort(
  ([, a], [, b]) =>
    (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0),
);

@Catch()
export class PromotionsProblemFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    @Inject(PROMOTIONS_OPERATION_LOGGER)
    private readonly logger: PromotionsOperationLogger,
  ) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const operation = operationsBySpecificity.find(
      ([, o]) =>
        o.method === request.method &&
        new RegExp(
          '^' + o.path.replace(/\{[^}]+\}/g, '[^/]+') + '/?$',
          'i',
        ).test(request.path),
    );
    if (!operation) {
      new BaseExceptionFilter(this.adapter.httpAdapter).catch(error, host);
      return;
    }
    if (
      (error instanceof HttpException && error.getStatus() === 400) ||
      (typeof error === 'object' &&
        error !== null &&
        'type' in error &&
        error.type === 'entity.parse.failed')
    )
      error = new PromotionsHttpError(400, 'VALIDACION');
    const problem =
      error instanceof CommercialInputError
        ? new PromotionsHttpError(400, 'VALIDACION')
        : error instanceof PromotionsHttpError
          ? error
          : error instanceof PromotionsPersistenceError ||
              error instanceof CommercialDependencyError
            ? new PromotionsHttpError(503, 'SERVICIO_NO_DISPONIBLE')
            : new PromotionsHttpError(500, 'ERROR_INTERNO');
    const id = correlationId(request);
    this.logger.http(
      operation[0],
      problem.status,
      id,
      requestElapsed(request),
      problem.code,
    );
    const titles: Record<string, string> = {
      VALIDACION: 'Datos de entrada inválidos',
      TOKEN_INVALIDO: 'Token ausente o inválido',
      SCOPE_INSUFICIENTE: 'Permisos insuficientes',
      CUPON_NO_ENCONTRADO: 'Cupón no encontrado',
      PROMOCION_NO_ENCONTRADA: 'Promoción no encontrada',
      REGLA_RECOMENDACION_NO_ENCONTRADA: 'Regla de recomendación no encontrada',
      SERVICIO_NO_DISPONIBLE: 'Servicio temporalmente no disponible',
      ERROR_INTERNO: 'Error interno',
    };
    response
      .status(problem.status)
      .type('application/problem+json')
      .setHeader('X-Correlation-Id', id);
    response.json({
      type: '/errores/' + problem.code.toLowerCase().replaceAll('_', '-'),
      title: titles[problem.code] ?? 'Error',
      status: problem.status,
      code: problem.code,
      correlationId: id,
    });
  }
}
@Controller('api/v1')
@UseGuards(PromotionsQueryGuard)
export class PromotionsQueryController {
  constructor(
    @Inject(PromotionsQueryService)
    private readonly service: PromotionsQueryService,
  ) {}
  @Get('promociones') @QueryOperation('listarPromociones') list(
    @Req() r: Request,
  ) {
    return this.service.execute('listarPromociones', r);
  }
  @Get('promociones/administracion')
  @QueryOperation('listarPromocionesAdmin')
  admin(@Req() r: Request) {
    return this.service.execute('listarPromocionesAdmin', r);
  }
  @Get('promociones/:promocionId')
  @QueryOperation('obtenerPromocionAdmin')
  promotion(@Req() r: Request) {
    return this.service.execute('obtenerPromocionAdmin', r);
  }
  @Get('cupones') @QueryOperation('listarCupones') coupons(@Req() r: Request) {
    return this.service.execute('listarCupones', r);
  }
  @Get('cupones/:cuponId') @QueryOperation('obtenerCuponAdmin') coupon(
    @Req() r: Request,
  ) {
    return this.service.execute('obtenerCuponAdmin', r);
  }
  @Get('recomendaciones/reglas')
  @QueryOperation('listarReglasRecomendacion')
  rules(@Req() r: Request) {
    return this.service.execute('listarReglasRecomendacion', r);
  }
  @Get('recomendaciones/reglas/:reglaId')
  @QueryOperation('obtenerReglaRecomendacion')
  rule(@Req() r: Request) {
    return this.service.execute('obtenerReglaRecomendacion', r);
  }
  @Get('recomendaciones')
  @QueryOperation('obtenerRecomendaciones')
  recommendations(@Req() r: Request) {
    return this.service.execute('obtenerRecomendaciones', r);
  }
  @Post('promociones/evaluar')
  @HttpCode(200)
  @QueryOperation('evaluarPromociones')
  evaluate(@Req() r: Request) {
    return this.service.execute('evaluarPromociones', r);
  }
  @Post('cupones/validar')
  @HttpCode(200)
  @QueryOperation('validarCupon')
  validateCoupon(@Req() r: Request) {
    return this.service.execute('validarCupon', r);
  }
}
