import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { GATEWAY_SETTINGS, type GatewaySettings } from './gateway-settings.js';
import type { ContractRoute } from './contract-route.js';
import { readLimitedResponse } from './bounded-response.js';

export class GatewayFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export type JwtClaims = Readonly<Record<string, unknown>>;
export type KeySource = () => Promise<readonly JsonWebKey[]>;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function decode(value: string): unknown {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error();
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value) throw new Error();
  return JSON.parse(buffer.toString('utf8'));
}

// RS256 and tipo=acceso/servicio follow G7's published token profile.
export class SignedIdentityVerifier {
  constructor(
    private readonly issuer: string,
    private readonly keys: KeySource,
  ) {}

  async verify(token: string): Promise<JwtClaims> {
    try {
      if (token.length > 16384) throw new Error();
      const parts = token.split('.');
      if (parts.length !== 3 || !/^[a-zA-Z0-9_-]+$/.test(parts[2]))
        throw new Error();
      const header = decode(parts[0]);
      const claims = decode(parts[1]);
      if (
        !object(header) ||
        !object(claims) ||
        header.alg !== 'RS256' ||
        typeof header.kid !== 'string' ||
        header.crit !== undefined ||
        (header.typ !== undefined && header.typ !== 'JWT')
      )
        throw new Error();
      const keys = await this.keys();
      const matches = keys.filter(
        (key) =>
          key.kid === header.kid &&
          key.kty === 'RSA' &&
          (!key.alg || key.alg === 'RS256') &&
          (!key.use || key.use === 'sig') &&
          (!key.key_ops ||
            (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) &&
          !key.d,
      );
      if (matches.length !== 1) throw new Error();
      const key = createPublicKey({ key: matches[0], format: 'jwk' });
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
        claims.iss !== this.issuer ||
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        !Number.isSafeInteger(claims.iat) ||
        typeof claims.jti !== 'string' ||
        !claims.jti.trim() ||
        !['acceso', 'servicio'].includes(String(claims.tipo)) ||
        !Number.isSafeInteger(claims.exp) ||
        (claims.exp as number) <= now ||
        (claims.nbf !== undefined &&
          (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now))
      )
        throw new Error();
      return claims;
    } catch (error: unknown) {
      if (error instanceof GatewayFailure && error.status === 503) throw error;
      throw new GatewayFailure(401, 'TOKEN_INVALIDO');
    }
  }
}

@Injectable()
export class GatewayIdentity {
  private cached: readonly JsonWebKey[] = [];
  private expires = 0;
  private loading?: Promise<readonly JsonWebKey[]>;

  constructor(
    @Inject(GATEWAY_SETTINGS) private readonly settings: GatewaySettings,
  ) {}

  private async keys(): Promise<readonly JsonWebKey[]> {
    if (Date.now() < this.expires) return this.cached;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        if (!this.settings.jwksUrl) throw new Error();
        const response = await fetch(this.settings.jwksUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(this.settings.timeoutMs),
        });
        if (!response.ok) throw new Error();
        const text = (
          await readLimitedResponse(response, 1024 * 1024)
        ).toString('utf8');
        const data: unknown = JSON.parse(text);
        if (
          !object(data) ||
          !Array.isArray(data.keys) ||
          data.keys.length > 100 ||
          !data.keys.every(object)
        )
          throw new Error();
        this.cached = data.keys;
        this.expires = Date.now() + 60000;
        return this.cached;
      } catch {
        throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      }
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  async authenticate(token: string): Promise<JwtClaims> {
    if (!this.settings.issuer)
      throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
    return new SignedIdentityVerifier(this.settings.issuer, () =>
      this.keys(),
    ).verify(token);
  }

  async authorize(
    route: ContractRoute,
    authorization: string | undefined,
  ): Promise<void> {
    if (isDemoBypassRoute(route, this.settings)) return;
    if (this.settings.readOnlyDemoEnabled)
      throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
    if (!route.security.length) {
      if (!this.settings.publicOperations.includes(route.operationId))
        throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
      return;
    }
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
    if (!bearer) throw new GatewayFailure(401, 'TOKEN_INVALIDO');
    const claims = await this.authenticate(bearer[1]);
    if (
      claims.tipo === 'servicio' &&
      route.security.includes('serviceBearer')
    ) {
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const scopes =
        typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
      if (!route.audience || !audience.includes(route.audience))
        throw new GatewayFailure(401, 'TOKEN_INVALIDO');
      if (
        !route.scope ||
        !scopes.includes(route.scope) ||
        !route.clients?.includes(String(claims.sub))
      )
        throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
    } else if (
      claims.tipo === 'acceso' &&
      route.security.includes('userBearer')
    ) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          String(claims.sub),
        ) ||
        !Array.isArray(claims.roles) ||
        !claims.roles.every((role) => typeof role === 'string')
      )
        throw new GatewayFailure(401, 'TOKEN_INVALIDO');
      // Arquitectura §1.2.1: the canonical human actor in G6 is Gestor Comercial.
      if (!claims.roles.includes(route.role ?? 'GESTOR_COMERCIAL'))
        throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
    } else throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
    // Never replace the mandatory Pricing introspection with successful JWT validation.
    if (route.introspection)
      throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
  }
}

const readOnlyDemoOperations = new Set([
  'listarProductos',
  'obtenerProducto',
  'obtenerProductoPorSlug',
  'listarCategorias',
  'listarMarcas',
  'obtenerPrecioBaseProducto',
]);

/** Selects a bypass only for routes already found in CONTRACT_ROUTES. */
export function isDemoBypassRoute(
  route: ContractRoute,
  settings: GatewaySettings,
): boolean {
  return (
    settings.demoNoAuthEnabled ||
    (settings.readOnlyDemoEnabled === true &&
      route.method === 'GET' &&
      readOnlyDemoOperations.has(route.operationId))
  );
}
