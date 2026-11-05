import { Inject, Injectable } from '@nestjs/common';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingReadGuard, record } from './pricing-read.guard.js';
import { PricingHttpError } from './pricing-http.error.js';

export type PricingServiceScope =
  'catalogo:leer' | 'precios:leer' | 'tokens:introspeccion';

@Injectable()
export class CatalogServiceToken {
  private readonly cached = new Map<string, { value: string; until: number }>();
  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    @Inject(PricingReadGuard) private readonly verifier: PricingReadGuard,
  ) {}

  async get(
    scope: PricingServiceScope = 'catalogo:leer',
  ): Promise<string | null> {
    if (this.config.demoNoAuthEnabled && scope === 'catalogo:leer') return null;
    const cached = this.cached.get(scope);
    if (cached && Date.now() < cached.until) return cached.value;
    this.cached.delete(scope);
    try {
      if (!this.config.serviceToken) throw new Error();
      const response = await fetch(this.config.serviceToken.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(1000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'modulo-productos',
          client_secret: this.config.serviceToken.secret,
          scope,
        }),
      });
      if (
        !response.ok ||
        !response.body ||
        response.headers.get('content-type')?.split(';')[0] !==
          'application/json'
      ) {
        await response.body?.cancel();
        throw new Error();
      }
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
      if (
        !record(body) ||
        body.tokenType !== 'Bearer' ||
        typeof body.accessToken !== 'string' ||
        !Number.isSafeInteger(body.expiresIn) ||
        (body.expiresIn as number) <= 0 ||
        !Array.isArray(body.scopes) ||
        !body.scopes.every((scope) => typeof scope === 'string') ||
        !body.scopes.includes(scope)
      )
        throw new Error();
      await this.verifier.authorize(body.accessToken, true, scope);
      // Solo se inspeccionan claims después de verificar la firma y el issuer.
      const claims: unknown = JSON.parse(
        Buffer.from(body.accessToken.split('.')[1], 'base64url').toString(
          'utf8',
        ),
      );
      if (
        !record(claims) ||
        claims.tipo !== 'servicio' ||
        claims.sub !== 'modulo-productos' ||
        typeof claims.exp !== 'number'
      )
        throw new Error();
      this.cached.set(scope, {
        value: body.accessToken,
        until:
          Math.min(
            claims.exp * 1000,
            Date.now() + (body.expiresIn as number) * 1000,
          ) - 5000,
      });
      return body.accessToken;
    } catch {
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    }
  }
}
