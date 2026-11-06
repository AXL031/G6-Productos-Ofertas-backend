import {
  createPublicKey,
  createVerify,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class BulkUserBearerGuard implements CanActivate {
  private static simulatedKeys: Array<Record<string, unknown>> = [];
  private static simulatedKeysExpireAt = 0;

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
      mode === 'PUBLIC_READ_ONLY' &&
      request.method === 'GET' &&
      request.path === '/api/v1/carga-masiva/productos/plantilla' &&
      context.getHandler().name === 'descargarPlantillaProductos' &&
      publicOperations.includes('descargarPlantillaProductos') &&
      request.headers.authorization === undefined
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
      if (mode === 'SIMULATED_AUTH') {
        const jwksUrl = process.env.SIMULATED_AUTH_JWKS_URL;
        if (!jwksUrl || typeof header.kid !== 'string') throw new Error();
        if (Date.now() >= BulkUserBearerGuard.simulatedKeysExpireAt) {
          const endpoint = new URL(jwksUrl);
          if (
            endpoint.protocol !== 'https:' &&
            !(
              process.env.NODE_ENV === 'test' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
            )
          )
            throw new Error();
          const response = await fetch(endpoint, {
            redirect: 'error',
            signal: AbortSignal.timeout(2500),
          });
          const raw = await response.text();
          if (!response.ok || raw.length > 65536) throw new Error();
          const jwks: unknown = JSON.parse(raw);
          if (
            !jwks ||
            typeof jwks !== 'object' ||
            !Array.isArray((jwks as { keys?: unknown }).keys)
          )
            throw new Error();
          BulkUserBearerGuard.simulatedKeys = (
            jwks as { keys: Array<Record<string, unknown>> }
          ).keys;
          BulkUserBearerGuard.simulatedKeysExpireAt = Date.now() + 60000;
        }
        const matches = BulkUserBearerGuard.simulatedKeys.filter(
          (item) =>
            item.kid === header.kid &&
            item.kty === 'RSA' &&
            (item.use === undefined || item.use === 'sig') &&
            (item.alg === undefined || item.alg === 'RS256') &&
            typeof item.n === 'string' &&
            typeof item.e === 'string',
        );
        if (
          matches.length !== 1 ||
          !verify(
            'RSA-SHA256',
            Buffer.from(`${parts[0]}.${parts[1]}`),
            createPublicKey({ key: matches[0] as JsonWebKey, format: 'jwk' }),
            Buffer.from(parts[2]!, 'base64url'),
          )
        )
          throw new Error();
      } else {
        const key = process.env.G7_JWT_PUBLIC_KEY ?? process.env.JWT_PUBLIC_KEY;
        if (!key) throw new Error();
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${parts[0]}.${parts[1]}`);
        if (
          !verifier.verify(
            key.replace(/\\n/g, '\n'),
            Buffer.from(parts[2]!, 'base64url'),
          )
        )
          throw new Error();
      }
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
