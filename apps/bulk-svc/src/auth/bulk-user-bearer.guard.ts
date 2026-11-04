import { createVerify } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { isIP } from 'node:net';

@Injectable()
export class BulkUserBearerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const demo = process.env.GATEWAY_DEMO_NO_AUTH_ENABLED === 'true';
    const allowed = (process.env.BULK_DEMO_GATEWAY_IPS ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (demo && peer && isIP(peer) !== 0 && allowed.includes(peer)) return true;

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
    } catch {
      throw new UnauthorizedException('TOKEN_INVALIDO');
    }
    const key = process.env.G7_JWT_PUBLIC_KEY ?? process.env.JWT_PUBLIC_KEY;
    const issuer = process.env.G7_JWT_ISSUER;
    if (header.alg !== 'RS256' || !key || !issuer)
      throw new UnauthorizedException('TOKEN_INVALIDO');
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${parts[0]}.${parts[1]}`);
      if (
        !verifier.verify(
          key.replace(/\\n/g, '\n'),
          Buffer.from(parts[2]!, 'base64url'),
        )
      )
        throw new Error();
    } catch {
      throw new UnauthorizedException('TOKEN_INVALIDO');
    }
    const aud = claims.aud;
    if (
      claims.iss !== issuer ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.exp !== 'number' ||
      claims.exp <= Date.now() / 1000 ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf > Date.now() / 1000)) ||
      !(
        aud === 'api-productos' ||
        (Array.isArray(aud) && aud.includes('api-productos'))
      )
    )
      throw new UnauthorizedException('TOKEN_INVALIDO');
    if (
      !Array.isArray(claims.roles) ||
      !claims.roles.includes('GESTOR_COMERCIAL')
    )
      throw new ForbiddenException('SCOPE_INSUFICIENTE');
    return true;
  }
}
