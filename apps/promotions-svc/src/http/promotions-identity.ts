import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import type { Request } from 'express';
import { PromotionsConfigService } from '../infrastructure/config/promotions-config.js';
import { httpContracts } from './http-contract.generated.js';
import { restrictedDemoPeer } from './restricted-demo-peer.js';
import {
  isUuid,
  object,
  PromotionsHttpError,
  type HttpOperation,
} from './http-validation.js';

export const PROMOTIONS_JWKS = Symbol('PROMOTIONS_JWKS');
export type PromotionsKeySource = (
  kid: string,
) => Promise<readonly JsonWebKey[]>;
export const QueryOperation = (id: string) =>
  SetMetadata('promotions.operationId', id);
const unauthenticated = () => new PromotionsHttpError(401, 'TOKEN_INVALIDO');
function decode(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw unauthenticated();
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw unauthenticated();
  return JSON.parse(bytes.toString('utf8'));
}
export function remotePromotionsKeys(
  config: PromotionsConfigService,
): PromotionsKeySource {
  let cached: readonly JsonWebKey[] = [];
  let until = 0;
  let loading: Promise<readonly JsonWebKey[]> | undefined;
  return async (kid) => {
    if (Date.now() < until && cached.some((k) => k.kid === kid)) return cached;
    if (!loading)
      loading = (async () => {
        try {
          if (!config.settings.auth) throw new Error();
          const response = await fetch(config.settings.auth.jwksUrl, {
            redirect: 'error',
            signal: AbortSignal.timeout(2500),
          });
          if (!response.ok || !response.body) throw new Error();
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 65536) throw new Error();
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          const data: unknown = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          );
          if (
            !object(data) ||
            !Array.isArray(data.keys) ||
            data.keys.length > 100 ||
            !data.keys.every(object)
          )
            throw new Error();
          cached = data.keys;
          until = Date.now() + 60000;
          return cached;
        } catch {
          throw new PromotionsHttpError(503, 'SERVICIO_NO_DISPONIBLE');
        }
      })();
    const pending = loading;
    try {
      return await pending;
    } catch (error) {
      // G7's published profile: a JWKS outage must not invalidate known cached keys.
      if (cached.some((k) => k.kid === kid)) {
        until = Date.now() + 5000;
        return cached;
      }
      throw error;
    } finally {
      if (loading === pending) loading = undefined;
    }
  };
}
@Injectable()
export class PromotionsIdentity {
  constructor(
    @Inject(PromotionsConfigService)
    private readonly config: PromotionsConfigService,
    @Inject(PROMOTIONS_JWKS) private readonly keys: PromotionsKeySource,
  ) {}
  async authorize(
    operation: Pick<
      HttpOperation,
      'security' | 'audience' | 'scope' | 'clients'
    >,
    authorization: string | undefined,
  ): Promise<void> {
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
    if (!bearer || bearer[1].length > 16384) throw unauthenticated();
    if (!this.config.settings.auth)
      throw new PromotionsHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    let claims: Record<string, unknown>;
    try {
      const parts = bearer[1].split('.');
      if (parts.length !== 3) throw new Error();
      const header = decode(parts[0]);
      const payload = decode(parts[1]);
      if (
        !object(header) ||
        !object(payload) ||
        header.alg !== 'RS256' ||
        typeof header.kid !== 'string' ||
        !header.kid ||
        header.crit !== undefined ||
        (header.typ !== undefined && header.typ !== 'JWT') ||
        !/^[A-Za-z0-9_-]+$/.test(parts[2]) ||
        Buffer.from(parts[2], 'base64url').toString('base64url') !== parts[2]
      )
        throw new Error();
      const matches = (await this.keys(header.kid)).filter(
        (k) =>
          k.kid === header.kid &&
          k.kty === 'RSA' &&
          (!k.alg || k.alg === 'RS256') &&
          (!k.use || k.use === 'sig') &&
          (!k.key_ops ||
            (Array.isArray(k.key_ops) && k.key_ops.includes('verify'))) &&
          !['d', 'p', 'q', 'dp', 'dq', 'qi'].some((p) => p in k),
      );
      if (matches.length !== 1) throw new Error();
      const key = createPublicKey({ key: matches[0], format: 'jwk' });
      if (
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !verify(
          'RSA-SHA256',
          Buffer.from(parts[0] + '.' + parts[1]),
          key,
          Buffer.from(parts[2], 'base64url'),
        )
      )
        throw new Error();
      const now = Math.floor(Date.now() / 1000);
      if (
        payload.iss !== this.config.settings.auth.issuer ||
        typeof payload.sub !== 'string' ||
        !payload.sub.trim() ||
        !Number.isSafeInteger(payload.exp) ||
        (payload.exp as number) <= now ||
        !Number.isSafeInteger(payload.iat) ||
        (payload.iat as number) > now ||
        typeof payload.jti !== 'string' ||
        !payload.jti.trim() ||
        (payload.nbf !== undefined &&
          (!Number.isSafeInteger(payload.nbf) ||
            (payload.nbf as number) > now)) ||
        !['acceso', 'servicio'].includes(String(payload.tipo))
      )
        throw new Error();
      claims = payload;
    } catch (error) {
      if (error instanceof PromotionsHttpError && error.status === 503)
        throw error;
      throw unauthenticated();
    }
    const forbidden = () => new PromotionsHttpError(403, 'SCOPE_INSUFICIENTE');
    if (claims.tipo === 'servicio') {
      if (!operation.security.includes('serviceBearer')) throw forbidden();
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!operation.audience || !audience.includes(operation.audience))
        throw unauthenticated();
      if (
        !operation.scope ||
        typeof claims.scope !== 'string' ||
        !claims.scope.split(' ').includes(operation.scope) ||
        !operation.clients?.includes(String(claims.sub))
      )
        throw forbidden();
    } else {
      if (!operation.security.includes('userBearer')) throw forbidden();
      if (
        !isUuid(claims.sub) ||
        !Array.isArray(claims.roles) ||
        !claims.roles.every((r) => typeof r === 'string')
      )
        throw unauthenticated();
      if (!claims.roles.includes('GESTOR_COMERCIAL')) throw forbidden();
    }
  }
}
@Injectable()
export class PromotionsQueryGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PromotionsIdentity) private readonly identity: PromotionsIdentity,
    @Inject(PromotionsConfigService)
    private readonly config: PromotionsConfigService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const id = this.reflector.get<string>(
      'promotions.operationId',
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<Request>();
    if (!httpContracts[id])
      throw new PromotionsHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    if (this.config.settings.localDemoEnabled) {
      // Use the TCP peer, never proxy/identity headers supplied by a caller.
      const peer = request.socket.remoteAddress;
      if (!(await restrictedDemoPeer(peer)))
        throw new PromotionsHttpError(403, 'SCOPE_INSUFICIENTE');
      const operation = httpContracts[id];
      const path = new RegExp(
        '^' + operation.path.replace(/\{[^}]+\}/g, '[^/]+') + '/?$',
        'i',
      );
      if (request.method !== operation.method || !path.test(request.path))
        throw new PromotionsHttpError(403, 'SCOPE_INSUFICIENTE');
      // No synthetic user/service principal is installed. Business handlers run unchanged.
      return true;
    }
    await this.identity.authorize(
      httpContracts[id],
      request.header('authorization'),
    );
    return true;
  }
}
