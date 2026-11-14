import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseFilters,
  UseGuards,
  SetMetadata,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { PricingReads } from './pricing-reads.js';
import {
  COMMERCIAL_PRICING_READ,
  PricingReadGuard,
  uuid,
} from './pricing-read.guard.js';
import {
  channels,
  CommercialPrices,
  parseCommercialQuery,
} from './commercial-prices.js';
import { PricingHttpError, PricingHttpFilter } from './pricing-http.error.js';

function page(query: Record<string, unknown>) {
  if (Object.keys(query).some((key) => !['pagina', 'tamanio'].includes(key)))
    throw new PricingHttpError(400, 'VALIDACION');
  const parse = (value: unknown, fallback: number, maximum: number) => {
    if (value === undefined) return fallback;
    if (
      typeof value !== 'string' ||
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > maximum
    )
      throw new PricingHttpError(400, 'VALIDACION');
    return Number(value);
  };
  const tamanio = parse(query.tamanio, 20, 200);
  return {
    pagina: parse(
      query.pagina,
      1,
      Math.floor(Number.MAX_SAFE_INTEGER / tamanio),
    ),
    tamanio,
  };
}

function definitionChannel(query: Record<string, unknown>): string | null {
  if (Object.keys(query).some((key) => key !== 'channelId'))
    throw new PricingHttpError(400, 'VALIDACION');
  const channel = channels.find((name) => name === query.channelId);
  if (query.channelId !== undefined && channel === undefined)
    throw new PricingHttpError(400, 'VALIDACION');
  return channel ?? null;
}

@Controller('api/v1/precios')
@UseGuards(PricingReadGuard)
@UseFilters(PricingHttpFilter)
export class PricingReadController {
  constructor(
    @Inject(PricingReads) private readonly reads: PricingReads,
    @Inject(CommercialPrices) private readonly commercial: CommercialPrices,
  ) {}

  @Get()
  @SetMetadata(COMMERCIAL_PRICING_READ, true)
  batch(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { skus, channel, at, historical } = parseCommercialQuery(query, true);
    return this.commercial.batch(
      skus,
      channel,
      at,
      historical,
      String(response.getHeader('X-Correlation-Id')),
    );
  }
  @Get('skus/:sku')
  @SetMetadata(COMMERCIAL_PRICING_READ, true)
  sku(
    @Param('sku') sku: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { channel, at, historical } = parseCommercialQuery(query);
    return this.commercial.sku(
      sku,
      channel,
      at,
      historical,
      String(response.getHeader('X-Correlation-Id')),
    );
  }

  @Get('productos/:productoId')
  product(
    @Param('productoId') productId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (Object.keys(query).length)
      throw new PricingHttpError(400, 'VALIDACION');
    return this.reads.product(productId);
  }

  @Get('administracion/productos/:productoId')
  adminProductDefinition(
    @Param('productoId') productId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (!uuid.test(productId)) throw new PricingHttpError(400, 'VALIDACION');
    return this.reads.adminDefinition({ productId }, definitionChannel(query));
  }

  @Get('administracion/skus/:sku')
  adminSkuDefinition(
    @Param('sku') sku: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (!sku.trim() || sku.includes('\0'))
      throw new PricingHttpError(400, 'VALIDACION');
    return this.reads.adminDefinition({ sku }, definitionChannel(query));
  }

  @Get('productos/:productoId/programaciones')
  productSchedules(
    @Param('productoId') productId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { pagina, tamanio } = page(query);
    return this.reads.schedules({ productId }, pagina, tamanio);
  }

  @Get('skus/:sku/programaciones')
  skuSchedules(
    @Param('sku') sku: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { pagina, tamanio } = page(query);
    return this.reads.schedules({ sku }, pagina, tamanio);
  }

  @Get('importaciones/:batchId/reporte')
  async importReport(
    @Param('batchId') batchId: string,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ) {
    if (!uuid.test(batchId) || Object.keys(query).length)
      throw new PricingHttpError(400, 'VALIDACION');
    const result = await this.reads.imported(batchId);
    const quote = (value: unknown) =>
      '"' + String(value ?? '').replace(/"/g, '""') + '"';
    const lines = [
      'row_id,sku,status,code',
      ...(result.rows ?? []).map((row) =>
        [row.row_id, row.sku, row.status, row.code].map(quote).join(','),
      ),
    ];
    response
      .type('text/csv')
      .setHeader(
        'Content-Disposition',
        'attachment; filename="reporte-importacion-precios-' +
          batchId +
          '.csv"',
      );
    return response.status(200).send(lines.join('\r\n') + '\r\n');
  }

  @Get('importaciones/:batchId')
  imported(
    @Param('batchId') batchId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (!uuid.test(batchId) || Object.keys(query).length)
      throw new PricingHttpError(400, 'VALIDACION');
    return this.reads.imported(batchId);
  }
}
