import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  PricingMutations,
  type PriceFact,
} from '../application/pricing-mutations.js';
import type { PriceDefinition } from '../domain/price.js';
import { PricingReadGuard, uuid } from './pricing-read.guard.js';
import { PricingHttpError, PricingHttpFilter } from './pricing-http.error.js';
import {
  parsePriceScheduleRequest,
  parsePriceUpdateRequest,
} from './pricing-write.dto.js';
import { wireMoney, wireVersion } from './pricing-reads.js';

type WriteOperation =
  | 'actualizarPrecioSku'
  | 'actualizarPrecioBaseProducto'
  | 'programarPrecioSku'
  | 'programarPrecioBaseProducto';
export const PRICING_WRITE_AUTHORIZER = Symbol('PRICING_WRITE_AUTHORIZER');
export const PRICING_FACT_FACTORY = Symbol('PRICING_FACT_FACTORY');
export type PricingWriteAuthorizer = (
  operation: WriteOperation,
  authorization: string | undefined,
) => Promise<string>;
export type PricingFactFactory = (
  before: PriceDefinition,
  after: PriceDefinition,
  metadata: {
    actor: string;
    correlationId: string;
    at: Date;
    operation: WriteOperation;
  },
) => PriceFact;
@Controller('api/v1/precios')
@UseGuards(PricingReadGuard)
@UseFilters(PricingHttpFilter)
export class PricingWriteController {
  constructor(
    @Inject(PricingMutations) private readonly mutations: PricingMutations,
    @Optional()
    @Inject(PRICING_WRITE_AUTHORIZER)
    private readonly authorize?: PricingWriteAuthorizer,
    @Optional()
    @Inject(PRICING_FACT_FACTORY)
    private readonly fact?: PricingFactFactory,
  ) {}
  private async prerequisites(
    operation: WriteOperation,
    authorization: string | undefined,
    response: Response,
  ) {
    if (!this.authorize || !this.fact)
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    const actor = await this.authorize(operation, authorization);
    if (!uuid.test(actor))
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    return {
      actor,
      operation,
      at: new Date(),
      correlationId: String(response.getHeader('X-Correlation-Id')),
    };
  }
  @Patch('productos/:productoId')
  product(
    @Param('productoId') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.update({ productId: id }, body, authorization, response);
  }
  @Patch('skus/:sku')
  sku(
    @Param('sku') sku: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.update({ sku }, body, authorization, response);
  }
  private async update(
    target: { productId: string } | { sku: string },
    body: unknown,
    authorization: string | undefined,
    response: Response,
  ) {
    const operation =
      'productId' in target
        ? 'actualizarPrecioBaseProducto'
        : 'actualizarPrecioSku';
    const metadata = await this.prerequisites(
      operation,
      authorization,
      response,
    );
    const { channelId, expectedVersion, input } = parsePriceUpdateRequest(body);
    const result = await this.mutations.update(
      target,
      channelId,
      { ...input, usuarioId: metadata.actor },
      expectedVersion,
      metadata.at,
      (before, after) => {
        wireVersion(after.priceVersion);
        return this.fact!(before, after, metadata);
      },
    );
    const current = result.definition.validities.find(
      (v) => v.priceVersion === result.definition.priceVersion,
    )!;
    return {
      ...('productId' in target
        ? { product_id: target.productId }
        : {
            sku: target.sku,
            origen: 'SKU_OVERRIDE',
            vigencia_id: result.validityId,
          }),
      precio_regular: wireMoney(current.precioRegular),
      precio_oferta:
        current.precioOferta === null ? null : wireMoney(current.precioOferta),
      currency: current.currency,
      channel_id: channelId,
      valid_from: current.validFrom.toISOString(),
      valid_until: current.validUntil?.toISOString() ?? null,
      price_version: wireVersion(result.definition.priceVersion),
    };
  }
  @Post('productos/:productoId/programaciones')
  @HttpCode(201)
  productSchedule(
    @Param('productoId') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.schedule({ productId: id }, body, authorization, response);
  }
  @Post('skus/:sku/programaciones')
  @HttpCode(201)
  skuSchedule(
    @Param('sku') sku: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.schedule({ sku }, body, authorization, response);
  }
  private async schedule(
    target: { productId: string } | { sku: string },
    body: unknown,
    authorization: string | undefined,
    response: Response,
  ) {
    const operation =
      'productId' in target
        ? 'programarPrecioBaseProducto'
        : 'programarPrecioSku';
    const metadata = await this.prerequisites(
      operation,
      authorization,
      response,
    );
    const { channelId, input } = parsePriceScheduleRequest(body);
    const result = await this.mutations.schedule(
      target,
      channelId,
      { ...input, usuarioId: metadata.actor },
      metadata.at,
      (before, after) => {
        wireVersion(after.priceVersion);
        return this.fact!(before, after, metadata);
      },
    );
    return {
      programacionId: result.scheduled.id,
      ...('productId' in target
        ? { product_id: target.productId }
        : { sku: target.sku }),
      tipoPrecio: input.tipoPrecio,
      importe: wireMoney(input.importe),
      moneda: input.currency,
      channelId,
      validFrom: input.validFrom.toISOString(),
      validUntil: input.validUntil?.toISOString() ?? null,
      estado: 'SCHEDULED',
      priceVersion: wireVersion(result.definition.priceVersion),
    };
  }
}
