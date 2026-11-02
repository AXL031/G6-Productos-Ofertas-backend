import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CatalogConfig } from './config.js';
import { correlationId, isCorrelationId } from './correlation.js';

export const DEMO_PRICING = Symbol('DEMO_PRICING');

export interface CurrentProductPrice {
  precio_regular: number;
  precio_oferta: number | null;
  currency: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

@Injectable()
export class PricingClient {
  constructor(private readonly config: CatalogConfig) {}

  private async readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  async checkReady(): Promise<void> {
    // One read through the actual Pricing operation verifies route, guard and DB
    // without walking the demo catalog or manufacturing a price.
    await this.currentPrice('00000000-0000-4000-8000-000000000000');
  }

  async currentPrice(
    productId: string,
    timeoutMs = 2500,
    requestCorrelationId?: string,
  ): Promise<CurrentProductPrice | null> {
    try {
      if (!this.config.pricingOrigin) throw new Error();
      if (
        requestCorrelationId !== undefined &&
        !isCorrelationId(requestCorrelationId)
      )
        throw new Error();
      const response = await fetch(
        new URL(
          `/api/v1/precios/productos/${encodeURIComponent(productId)}`,
          this.config.pricingOrigin,
        ),
        {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'X-Correlation-Id': correlationId(requestCorrelationId) },
        },
      );
      if (response.status === 404) {
        if (
          response.headers.get('content-type')?.split(';')[0] !==
          'application/problem+json'
        )
          throw new Error();
        const failure = await this.readJson(response);
        if (!record(failure) || failure.code !== 'PRECIO_NO_ENCONTRADO')
          throw new Error();
        return null;
      }
      if (
        response.status !== 200 ||
        response.headers.get('content-type')?.split(';')[0] !==
          'application/json'
      )
        throw new Error();
      const body = await this.readJson(response);
      const now = Date.now();
      if (
        !record(body) ||
        body.product_id !== productId ||
        typeof body.precio_regular !== 'number' ||
        !Number.isFinite(body.precio_regular) ||
        body.precio_regular <= 0 ||
        (body.precio_oferta !== null &&
          (typeof body.precio_oferta !== 'number' ||
            !Number.isFinite(body.precio_oferta) ||
            body.precio_oferta <= 0 ||
            body.precio_oferta >= body.precio_regular)) ||
        typeof body.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(body.currency) ||
        body.channel_id !== null ||
        !Number.isSafeInteger(body.price_version) ||
        (body.price_version as number) < 0 ||
        !validDate(body.valid_from) ||
        Date.parse(body.valid_from) > now ||
        (body.valid_until !== null &&
          (!validDate(body.valid_until) || Date.parse(body.valid_until) <= now))
      )
        throw new Error();
      return {
        precio_regular: body.precio_regular,
        precio_oferta: body.precio_oferta as number | null,
        currency: body.currency,
      };
    } catch {
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    }
  }
}
