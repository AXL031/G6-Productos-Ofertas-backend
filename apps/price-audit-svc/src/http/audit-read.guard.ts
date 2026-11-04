import {
  createPublicKey,
  randomUUID,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PRICE_AUDIT_CONFIG, type AuditConfig } from '../config/environment.js';
import { AuditHttpError } from './audit-http.error.js';
import { SafeLogger } from '../logging/safe-logger.js';

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decode(value: string): unknown {
  if (!/^[\w-]+$/.test(value)) throw new Error();
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value) throw new Error();
  return JSON.parse(buffer.toString('utf8'));
}

@Injectable()
export class AuditReadGuard implements CanActivate {
  private cache: JsonWebKey[] = [];
  private expires = 0;
  private loading?: Promise<JsonWebKey[]>;

  constructor(
    @Inject(PRICE_AUDIT_CONFIG) private readonly config: AuditConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const correlation = request.headers['x-correlation-id'];
    response.setHeader(
      'X-Correlation-Id',
      typeof correlation === 'string' && uuid.test(correlation)
        ? correlation
        : randomUUID(),
    );
    const started = performance.now();
    response.once('finish', () =>
      new SafeLogger(this.config.nodeEnv).http(
        String(response.getHeader('X-Correlation-Id')),
        response.statusCode,
        performance.now() - started,
      ),
    );
    if (
      correlation !== undefined &&
      (typeof correlation !== 'string' || !uuid.test(correlation))
    )
      throw new AuditHttpError(400, 'VALIDACION');
    const bearer = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!bearer) throw new AuditHttpError(401, 'TOKEN_INVALIDO');
    (request as Request & { auditActor?: string }).auditActor =
      await this.authorize(bearer[1]);
    return true;
  }

  async authorize(token: string): Promise<string> {
    if (!this.config.auth)
      throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
    try {
      if (token.length > 16384) throw new Error();
      const parts = token.split('.');
      if (parts.length !== 3 || !/^[\w-]+$/.test(parts[2])) throw new Error();
      const header = decode(parts[0]);
      const claims = decode(parts[1]);
      if (
        !record(header) ||
        !record(claims) ||
        header.alg !== 'RS256' ||
        typeof header.kid !== 'string' ||
        header.crit !== undefined ||
        (header.typ !== undefined && header.typ !== 'JWT')
      )
        throw new Error();
      const keys = (await this.keys()).filter(
        (key) =>
          key.kid === header.kid &&
          key.kty === 'RSA' &&
          (!key.alg || key.alg === 'RS256') &&
          (!key.use || key.use === 'sig') &&
          (!key.key_ops ||
            (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) &&
          !key.d,
      );
      if (keys.length !== 1) throw new Error();
      const key = createPublicKey({ key: keys[0], format: 'jwk' });
      if (
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${parts[0]}.${parts[1]}`),
          key,
          Buffer.from(parts[2], 'base64url'),
        )
      )
        throw new Error();
      const now = Math.floor(Date.now() / 1000);
      if (
        claims.iss !== this.config.auth.issuer ||
        claims.tipo !== 'acceso' ||
        typeof claims.sub !== 'string' ||
        !uuid.test(claims.sub) ||
        !Number.isSafeInteger(claims.iat) ||
        (claims.iat as number) > now ||
        !Number.isSafeInteger(claims.exp) ||
        (claims.exp as number) <= now ||
        (claims.nbf !== undefined &&
          (!Number.isSafeInteger(claims.nbf) ||
            (claims.nbf as number) > now)) ||
        typeof claims.jti !== 'string' ||
        !claims.jti.trim() ||
        !Array.isArray(claims.roles) ||
        !claims.roles.every((role) => typeof role === 'string')
      )
        throw new Error();
      if (!claims.roles.includes('GESTOR_COMERCIAL'))
        throw new AuditHttpError(403, 'SCOPE_INSUFICIENTE');
      return claims.sub;
    } catch (error) {
      if (error instanceof AuditHttpError) throw error;
      throw new AuditHttpError(401, 'TOKEN_INVALIDO');
    }
  }

  private async keys(): Promise<JsonWebKey[]> {
    if (Date.now() < this.expires) return this.cache;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const response = await fetch(this.config.auth!.jwksUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok || !response.body) throw new Error();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 1024 * 1024) throw new Error();
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        if (
          !record(body) ||
          !Array.isArray(body.keys) ||
          body.keys.length > 100 ||
          !body.keys.every(record)
        )
          throw new Error();
        this.cache = body.keys;
        this.expires = Date.now() + 60000;
        return this.cache;
      } catch {
        throw new AuditHttpError(503, 'SERVICIO_NO_DISPONIBLE');
      }
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }
}
