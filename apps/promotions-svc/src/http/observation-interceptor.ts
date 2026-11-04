import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { tap } from 'rxjs';
import { httpContracts } from './http-contract.generated.js';
import { correlationId } from './http-validation.js';
import {
  PROMOTIONS_OPERATION_LOGGER,
  PromotionsOperationLogger,
} from '../infrastructure/logging/operation-logger.js';

const starts = new WeakMap<Request, number>();
export function requestElapsed(request: Request): number {
  return Math.max(
    0,
    performance.now() - (starts.get(request) ?? performance.now()),
  );
}
@Injectable()
export class PromotionsObservationInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROMOTIONS_OPERATION_LOGGER)
    private readonly logger: PromotionsOperationLogger,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const operation = this.reflector.get<string>(
      'promotions.operationId',
      context.getHandler(),
    );
    if (!Object.hasOwn(httpContracts, operation)) return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    starts.set(request, performance.now());
    const correlation = correlationId(request);
    response.setHeader('X-Correlation-Id', correlation);
    return next
      .handle()
      .pipe(
        tap(() =>
          this.logger.http(
            operation,
            response.statusCode,
            correlation,
            requestElapsed(request),
          ),
        ),
      );
  }
}
