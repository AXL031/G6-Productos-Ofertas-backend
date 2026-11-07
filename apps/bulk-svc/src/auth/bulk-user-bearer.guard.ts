import { createVerify } from 'node:crypto';
import { trustedJwksPublicKey, JwksUnavailable } from './trusted-jwks.js';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { isPhase1PublicRead } from '../phase1-public-reads.js';

@Injectable()
export class BulkUserBearerGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const mode = process.env.G6_SECURITY_MODE ?? 'G7_AUTHENTICATED';
    if (
      !['PUBLIC_READ_ONLY', 'SIMULATED_AUTH', 'G7_AUTHENTICATED'].includes(mode)
    )
      throw new UnauthorizedException('TOKEN_INVALIDO');
    const publicOperations = (process.env.BULK_PUBLIC_OPERATION_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (
      isPhase1PublicRead(
        request,
        mode,
        publicOperations,
        context.getHandler().name,
      )
    )
      return true;
    const token = request.headers.authorization;
    if (typeof token !== 'string' || !token.startsWith('Bearer '))
      throw new UnauthorizedException('TOKEN_INVALIDO');
    const parts = token.slice(7).trim().split('.');
    if (parts.length !== 3 || !parts[2])
      throw new UnauthorizedException('TOKEN_INVALIDO');
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(
        Buffer.from(parts[0]!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      claims = JSON.parse(
        Buffer.from(parts[1]!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      if (
        !header ||
        typeof header !== 'object' ||
        Array.isArray(header) ||
        !claims ||
        typeof claims !== 'object' ||
        Array.isArray(claims)
      )
        throw new Error('Invalid JWT objects');
    } catch {
      throw new UnauthorizedException('TOKEN_INVALIDO');
    }
    const issuer =
      mode === 'SIMULATED_AUTH'
        ? process.env.SIMULATED_AUTH_ISSUER
        : process.env.G7_JWT_ISSUER;
    if (header.alg !== 'RS256' || !issuer)
      throw new UnauthorizedException('TOKEN_INVALIDO');
    try {
      const key =
        mode === 'SIMULATED_AUTH' || process.env.G7_JWT_JWKS_URL !== undefined
          ? await trustedJwksPublicKey(
              token.slice(7).trim(),
              mode === 'SIMULATED_AUTH'
                ? process.env.SIMULATED_AUTH_JWKS_URL
                : process.env.G7_JWT_JWKS_URL,
              process.env.NODE_ENV,
            )
          : (process.env.G7_JWT_PUBLIC_KEY ?? process.env.JWT_PUBLIC_KEY);
      if (!key) throw new JwksUnavailable();
      const verifier = createVerify('RSA-SHA256');
      verifier.update(parts[0] + '.' + parts[1]);
      if (
        !verifier.verify(
          key.replace(/\\n/g, '\n'),
          Buffer.from(parts[2], 'base64url'),
        )
      )
        throw new Error();
    } catch (error) {
      if (error instanceof JwksUnavailable)
        throw new ServiceUnavailableException({
          code: 'SERVICIO_NO_DISPONIBLE',
        });
      throw new UnauthorizedException('TOKEN_INVALIDO');
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.iss !== issuer ||
      claims.tipo !== 'acceso' ||
      typeof claims.sub !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        claims.sub,
      ) ||
      !Number.isSafeInteger(claims.iat) ||
      (claims.iat as number) > now ||
      !Number.isSafeInteger(claims.exp) ||
      (claims.exp as number) <= now ||
      typeof claims.jti !== 'string' ||
      !claims.jti.trim() ||
      (claims.nbf !== undefined &&
        (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now)) ||
      !Array.isArray(claims.roles) ||
      !claims.roles.every((role) => typeof role === 'string')
    )
      throw new UnauthorizedException('TOKEN_INVALIDO');
    if (!(claims.roles as string[]).includes('GESTOR_COMERCIAL'))
      throw new ForbiddenException('SCOPE_INSUFICIENTE');
    return true;
  }
}
