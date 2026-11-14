import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { GATEWAY_SETTINGS, type GatewaySettings } from './gateway-settings.js';
import type { ContractRoute } from './contract-route.js';
import { readLimitedResponse } from './bounded-response.js';
import { isEligiblePublicRead } from './gateway-public-reads.js';

export class GatewayFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export type JwtClaims = Readonly<Record<string, unknown>>;
export type KeySource = (kid?: string) => Promise<readonly JsonWebKey[]>;

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
      const keys = await this.keys(header.kid);
      const matches = keys.filter(
        (key) =>
          key.kid === header.kid &&
          key.kty === 'RSA' &&
          (!key.alg || key.alg === 'RS256') &&
          (!key.use || key.use === 'sig') &&
          (!key.key_ops ||
            (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) &&
          !['d', 'p', 'q', 'dp', 'dq', 'qi'].some(
            (property) => property in key,
          ),
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
        (claims.iat as number) > now ||
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
  private serviceTokenCache?: { token: string; expiresAt: number };
  private serviceTokenLoading?: Promise<string>;
  private cached: readonly JsonWebKey[] = [];
  private expires = 0;
  private validUntil = 0;
  private loading?: Promise<readonly JsonWebKey[]>;

  constructor(
    @Inject(GATEWAY_SETTINGS) private readonly settings: GatewaySettings,
  ) {}

  private async keys(kid?: string): Promise<readonly JsonWebKey[]> {
    if (
      Date.now() < this.expires &&
      (!kid || this.cached.some((key) => key.kid === kid))
    )
      return this.cached;
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
        const directives = response.headers.get('cache-control') ?? '';
        const seconds = /(?:no-store|no-cache)/i.test(directives)
          ? 0
          : Math.min(
              3600,
              Number(directives.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 3600),
            );
        this.validUntil = Date.now() + seconds * 1000;
        this.expires = Date.now() + Math.min(60, seconds) * 1000;
        return this.cached;
      } catch {
        throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      }
    })();
    try {
      return await this.loading;
    } catch (error) {
      // Retain only a previously trusted kid within the bounded trust window.
      if (
        kid &&
        Date.now() < this.validUntil &&
        this.cached.some((key) => key.kid === kid)
      )
        return this.cached;
      throw error;
    } finally {
      this.loading = undefined;
    }
  }

  async authenticate(token: string): Promise<JwtClaims> {
    if (!this.settings.issuer)
      throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
    return new SignedIdentityVerifier(this.settings.issuer, (kid) =>
      this.keys(kid),
    ).verify(token);
  }

  async authorize(
    route: ContractRoute,
    authorization: string | undefined,
  ): Promise<void> {
    if (
      authorization === undefined &&
      this.settings.securityMode === 'PUBLIC_READ_ONLY' &&
      isEligiblePublicRead(route) &&
      this.settings.publicOperations.includes(route.operationId)
    )
      return;
    if (isDemoBypassRoute(route, this.settings)) return;
    if (this.settings.readOnlyDemoEnabled)
      throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
    if (!route.security.length) {
      if (
        this.settings.securityMode !== 'PUBLIC_READ_ONLY' ||
        !this.settings.publicOperations.includes(route.operationId)
      )
        throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
      const bearer = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
      if (!bearer) throw new GatewayFailure(401, 'TOKEN_INVALIDO');
      await this.authenticate(bearer[1]);
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
    if (
      this.settings.securityMode === 'G7_AUTHENTICATED' &&
      !this.settings.inventoryLocalGrantsEnabled &&
      [
        'listarTrasladosInventario',
        'obtenerTrasladoInventario',
        'registrarRecepcionTrasladoInventario',
      ].includes(route.operationId)
    )
      throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
    if (route.introspection && this.settings.securityMode !== 'SIMULATED_AUTH')
      await this.introspect(
        bearer[1],
        String(claims.sub),
        route.role ?? 'GESTOR_COMERCIAL',
      );
  }

  private async introspectionCredential(): Promise<string> {
    if (this.serviceTokenCache && this.serviceTokenCache.expiresAt > Date.now())
      return this.serviceTokenCache.token;
    if (!this.serviceTokenLoading)
      this.serviceTokenLoading = (async () => {
        const { serviceTokenUrl, serviceClientSecret, issuer } = this.settings;
        if (!serviceTokenUrl || !serviceClientSecret || !issuer)
          throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
        try {
          const tokenResponse = await fetch(serviceTokenUrl, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(
              Math.min(this.settings.timeoutMs, 1500),
            ),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: 'modulo-productos',
              client_secret: serviceClientSecret,
              scope: 'tokens:introspeccion',
            }),
          });
          const tokenBody = await this.jsonResponse(tokenResponse, 65536);
          if (
            !object(tokenBody) ||
            tokenBody.tokenType !== 'Bearer' ||
            typeof tokenBody.accessToken !== 'string' ||
            !Number.isSafeInteger(tokenBody.expiresIn) ||
            (tokenBody.expiresIn as number) <= 0 ||
            !Array.isArray(tokenBody.scopes) ||
            !tokenBody.scopes.every((scope) => typeof scope === 'string') ||
            !tokenBody.scopes.includes('tokens:introspeccion')
          )
            throw new Error('Invalid client token response');
          const serviceClaims = await this.authenticate(
            tokenBody.accessToken,
          ).catch(() => {
            throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
          });
          const serviceAudiences = Array.isArray(serviceClaims.aud)
            ? serviceClaims.aud
            : [serviceClaims.aud];
          const serviceScopes =
            typeof serviceClaims.scope === 'string'
              ? serviceClaims.scope.split(/\s+/)
              : [];
          if (
            serviceClaims.tipo !== 'servicio' ||
            serviceClaims.sub !== 'modulo-productos' ||
            !serviceAudiences.includes('api-seguridad')
          )
            throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
          if (!serviceScopes.includes('tokens:introspeccion'))
            throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');

          const granted = new Set(serviceScopes.filter(Boolean));
          if (
            granted.size !== tokenBody.scopes.length ||
            !tokenBody.scopes.every((scope) => granted.has(String(scope)))
          )
            throw new Error('Inconsistent token grants');
          const now = Date.now();
          const lifetime = Math.min(
            Number(tokenBody.expiresIn) * 1000,
            Number(serviceClaims.exp) * 1000 - now,
          );
          if (!Number.isFinite(lifetime) || lifetime <= 0)
            throw new Error('Expired technical token');
          this.serviceTokenCache = {
            token: tokenBody.accessToken,
            expiresAt: now + lifetime - Math.min(30000, lifetime / 10),
          };
          return tokenBody.accessToken;
        } catch {
          throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
        }
      })().finally(() => {
        this.serviceTokenLoading = undefined;
      });
    return this.serviceTokenLoading;
  }

  private async introspect(
    userToken: string,
    subject: string,
    role: string,
  ): Promise<void> {
    const { serviceTokenUrl, serviceClientSecret, issuer } = this.settings;
    if (!serviceTokenUrl || !serviceClientSecret || !issuer)
      throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
    try {
      const technicalToken = await this.introspectionCredential();
      const response = await fetch(
        new URL('/api/v1/auth/introspeccion', new URL(issuer).origin),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(this.settings.timeoutMs, 1500)),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${technicalToken}`,
          },
          body: JSON.stringify({ token: userToken }),
        },
      );
      if (response.status === 401 || response.status === 403) {
        this.serviceTokenCache = undefined;
        await response.body?.cancel();
        throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      }
      const result = await this.jsonResponse(response, 65536);
      if (!object(result) || typeof result.activo !== 'boolean')
        throw new Error('Invalid introspection response');
      if (!result.activo) {
        if (
          ![
            'TOKEN_VENCIDO',
            'TOKEN_REVOCADO',
            'FIRMA_INVALIDA',
            'USUARIO_INACTIVO',
            'USUARIO_BLOQUEADO',
          ].includes(String(result.motivo))
        )
          throw new Error('Invalid inactive introspection response');
        throw new GatewayFailure(401, 'TOKEN_INVALIDO');
      }
      if (
        typeof result.sub !== 'string' ||
        result.tipo !== 'acceso' ||
        !Array.isArray(result.roles) ||
        !result.roles.every((value) => typeof value === 'string') ||
        !Array.isArray(result.permisos) ||
        !result.permisos.every((value) => typeof value === 'string') ||
        (result.exp !== undefined &&
          (!Number.isSafeInteger(result.exp) ||
            Number(result.exp) <= Math.floor(Date.now() / 1000))) ||
        (result.email !== undefined && typeof result.email !== 'string')
      )
        throw new Error('Invalid active introspection response');
      if (result.sub !== subject)
        throw new GatewayFailure(401, 'TOKEN_INVALIDO');
      if (!result.roles.includes(role))
        throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
    } catch (error) {
      if (error instanceof GatewayFailure) throw error;
      throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
    }
  }

  private async jsonResponse(
    response: Response,
    maxBytes: number,
  ): Promise<unknown> {
    if (
      !response.ok ||
      response.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json'
    ) {
      await response.body?.cancel();
      throw new Error('G7 response unavailable');
    }
    const body = await readLimitedResponse(response, maxBytes);
    return JSON.parse(body.toString('utf8')) as unknown;
  }
}

/** Selects a bypass only for routes already found in CONTRACT_ROUTES. */
export function isDemoBypassRoute(
  route: ContractRoute,
  settings: GatewaySettings,
): boolean {
  if (
    settings.securityMode === 'PUBLIC_READ_ONLY' ||
    settings.securityMode === 'SIMULATED_AUTH'
  )
    return false;
  return false;
}
