import { PHASE1_PUBLIC_OPERATION_IDS } from '../phase1-public-reads.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import type { PricingCatalogContext } from './commercial-prices.js';
import { record, uuid } from './pricing-read.guard.js';
import { PricingHttpError } from './pricing-http.error.js';

import { createH4CatalogClient } from './h4-catalog-client.js';

export const PRICING_CATALOG_H4 = Symbol('PRICING_CATALOG_H4');
export const PRICING_CATALOG_TOKEN = Symbol('PRICING_CATALOG_TOKEN');
export type PricingCatalogToken = (sku?: string) => Promise<string | null>;

@Injectable()
export class CatalogContextHttp implements PricingCatalogContext {
  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    @Optional()
    @Inject(PRICING_CATALOG_TOKEN)
    private readonly token?: PricingCatalogToken,
    @Optional()
    @Inject(PRICING_CATALOG_H4)
    private readonly h4?: ReturnType<typeof createH4CatalogClient>,
  ) {}

  async resolve(sku: string, correlationId = randomUUID()) {
    try {
      if ((!this.h4 && !this.config.catalogUrl) || !uuid.test(correlationId))
        throw new Error();
      // Credencial propia: nunca se recibe ni reenvía el bearer del consumidor.
      const publicRead =
        !this.h4 &&
        this.config.securityMode === 'PUBLIC_READ_ONLY' &&
        this.config.publicOperations?.some((id) =>
          PHASE1_PUBLIC_OPERATION_IDS.has(id),
        );
      const authorization = publicRead ? undefined : await this.token?.(sku);
      if (!publicRead && !authorization) throw new Error();
      const headers = {
        Accept: 'application/json, application/problem+json',
        'X-Correlation-Id': correlationId,
        ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}),
      };
      const response = this.h4
        ? await this.h4.get(sku, headers)
        : await fetch(
            this.config.catalogUrl +
              '/api/v1/productos/skus/' +
              encodeURIComponent(sku) +
              '/contexto',
            { headers, redirect: 'error', signal: AbortSignal.timeout(2000) },
          );
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 65536) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(body)) throw new Error();
      const contentType = response.headers.get('content-type')?.split(';')[0];
      if (
        response.status === 404 &&
        contentType === 'application/problem+json' &&
        body.status === 404 &&
        body.code === 'SKU_NO_ENCONTRADO'
      )
        return null;
      if (
        response.status !== 200 ||
        contentType !== 'application/json' ||
        body.sku !== sku ||
        typeof body.productId !== 'string' ||
        !body.productId.trim() ||
        typeof body.isVariant !== 'boolean' ||
        typeof body.active !== 'boolean' ||
        typeof body.eligible !== 'boolean'
      )
        throw new Error();
      return {
        sku,
        productId: body.productId,
        isVariant: body.isVariant,
        active: body.active,
        eligible: body.eligible,
      };
    } catch {
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    }
  }

  async resolveBatch(skus: readonly string[], correlationId = randomUUID()) {
    try {
      if (
        !this.config.catalogUrl ||
        this.h4 ||
        !uuid.test(correlationId) ||
        skus.length < 1 ||
        skus.length > 100 ||
        skus.some((sku) => typeof sku !== 'string' || !sku || sku.length > 256)
      )
        throw new Error();
      // Este endpoint es privado: exige siempre identidad técnica propia, aun
      // en modos legacy de lecturas públicas. Nunca recibe el bearer humano.
      const authorization = await this.token?.();
      if (!authorization) throw new Error();
      const response = await fetch(
        this.config.catalogUrl + '/api/v1/productos/skus/contexto/lote',
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(2500),
          headers: {
            Accept: 'application/json, application/problem+json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authorization}`,
            'X-Correlation-Id': correlationId,
          },
          body: JSON.stringify({ skus }),
        },
      );
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const contentType = response.headers.get('content-type')?.split(';')[0];
      if (response.status !== 200 || contentType !== 'application/json')
        throw new Error();
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(body) || !Array.isArray(body.items)) throw new Error();
      if (body.items.length !== skus.length) throw new Error();
      return body.items.map((item: unknown, index: number) => {
        const expectedSku = skus[index]!;
        if (!record(item) || item.sku !== expectedSku) throw new Error();
        if (item.status === 'SKU_NO_ENCONTRADO' && item.context === null)
          return null;
        if (item.status !== 'FOUND' || !record(item.context)) throw new Error();
        const context = item.context;
        if (
          context.sku !== expectedSku ||
          typeof context.productId !== 'string' ||
          !context.productId ||
          typeof context.isVariant !== 'boolean' ||
          typeof context.active !== 'boolean' ||
          typeof context.eligible !== 'boolean'
        )
          throw new Error();
        return {
          sku: expectedSku,
          productId: context.productId,
          isVariant: context.isVariant,
          active: context.active,
          eligible: context.eligible,
        };
      });
    } catch {
      // No retry: una sola consulta privada y cualquier frontera inválida falla cerrada.
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    }
  }
}
