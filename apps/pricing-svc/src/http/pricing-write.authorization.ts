import { Inject, Injectable } from '@nestjs/common';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingHttpError } from './pricing-http.error.js';
import { CatalogServiceToken } from './catalog-token.js';
import { PricingReadGuard, record } from './pricing-read.guard.js';
import type { WriteOperation } from './pricing-write.controller.js';

const INTROSPECTION_SCOPE = 'tokens:introspeccion';
const MAX_RESPONSE_BYTES = 64 * 1024;
const userIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (
    response.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    !response.body
  )
    throw new Error('Respuesta G7 inválida.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Respuesta G7 extensa.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

@Injectable()
export class PricingWriteAuthorization {
  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    @Inject(PricingReadGuard) private readonly verifier: PricingReadGuard,
    @Inject(CatalogServiceToken)
    private readonly serviceToken: CatalogServiceToken,
  ) {}

  async authorize(
    _operation: WriteOperation,
    authorization: string | undefined,
  ): Promise<string> {
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
    if (!bearer) throw new PricingHttpError(401, 'TOKEN_INVALIDO');

    // Primero se verifica firma, issuer, vigencia, identidad humana y rol.
    const claims = await this.verifier.authorize(bearer[1]);
    const actor = claims.sub;
    if (typeof actor !== 'string' || !userIdPattern.test(actor))
      throw new PricingHttpError(401, 'TOKEN_INVALIDO');

    if (!this.config.auth)
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    try {
      const token = await this.serviceToken.get(INTROSPECTION_SCOPE);
      if (!token) throw new Error('Credencial G7 no disponible.');
      const endpoint = new URL(
        '/api/v1/auth/introspeccion',
        this.config.auth.issuer,
      );
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(1500),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ token: bearer[1] }),
      });
      if (response.status === 401) {
        await response.body?.cancel();
        throw new PricingHttpError(401, 'TOKEN_INVALIDO');
      }
      if (response.status === 403) {
        await response.body?.cancel();
        throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
      }
      const body = await readBoundedJson(response);
      if (
        !record(body) ||
        typeof body.activo !== 'boolean' ||
        (body.activo &&
          (typeof body.sub !== 'string' ||
            !userIdPattern.test(body.sub) ||
            !Array.isArray(body.roles) ||
            !body.roles.every((role) => typeof role === 'string') ||
            !Array.isArray(body.permisos) ||
            !body.permisos.every(
              (permission) => typeof permission === 'string',
            ) ||
            body.tipo !== 'acceso'))
      )
        throw new Error('Respuesta G7 incompatible.');
      if (!body.activo) throw new PricingHttpError(401, 'TOKEN_INVALIDO');
      if (body.sub !== actor) throw new PricingHttpError(401, 'TOKEN_INVALIDO');
      if (!(body.roles as string[]).includes('GESTOR_COMERCIAL'))
        throw new PricingHttpError(403, 'SCOPE_INSUFICIENTE');
      return actor;
    } catch (error) {
      if (error instanceof PricingHttpError) throw error;
      throw new PricingHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    }
  }
}
