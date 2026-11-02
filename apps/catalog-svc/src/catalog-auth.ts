import {
  CanActivate,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
  SetMetadata,
  Optional,
  type ExecutionContext,
} from '@nestjs/common';
import { SanitizedLogger } from './sanitized-logger.js';
import { isCorrelationId } from './correlation.js';
import { Reflector } from '@nestjs/core';
import {
  CATALOG_READ_DEMO,
  CATALOG_MARKETPLACE_PREVIEW,
  type CatalogReadDemo,
} from './catalog-read-demo.js';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import type { Request } from 'express';

export const CATALOG_SECURITY_CONFIG = Symbol('CATALOG_SECURITY_CONFIG');
const CATALOG_AUTH_POLICY = Symbol('CATALOG_AUTH_POLICY');
const SECURITY_AUDIENCE = 'api-productos';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CatalogSecurityConfig {
  issuer: string;
  discoveryUrl: string;
  jwksUrl: string;
}

export function readCatalogSecurityConfig(
  env: Record<string, string | undefined> = process.env,
): CatalogSecurityConfig | undefined {
  const values = [
    env.SECURITY_ISSUER,
    env.SECURITY_DISCOVERY_URL,
    env.SECURITY_JWKS_URL,
  ];
  if (values.every((value) => value === undefined || value.trim() === ''))
    return undefined;
  if (values.some((value) => !value?.trim()))
    throw new Error(
      'SECURITY_ISSUER, SECURITY_DISCOVERY_URL y SECURITY_JWKS_URL deben configurarse juntos.',
    );

  const issuer = values[0]!.trim();
  const discoveryUrl = values[1]!.trim();
  const jwksUrl = values[2]!.trim();
  try {
    const issuerUrl = new URL(issuer);
    const discovery = new URL(discoveryUrl);
    const jwks = new URL(jwksUrl);
    if (
      !['http:', 'https:'].includes(issuerUrl.protocol) ||
      !['http:', 'https:'].includes(discovery.protocol) ||
      !['http:', 'https:'].includes(jwks.protocol) ||
      issuerUrl.username ||
      issuerUrl.password ||
      discovery.username ||
      discovery.password ||
      jwks.username ||
      jwks.password ||
      issuerUrl.hash ||
      discovery.hash ||
      jwks.hash ||
      [issuerUrl, discovery, jwks].some(
        (url) =>
          url.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '::1', '[::1]'].includes(
            url.hostname.toLowerCase(),
          ),
      )
    )
      throw new Error();
  } catch {
    throw new Error(
      'La configuración de Seguridad debe usar URLs HTTP(S) válidas.',
    );
  }
  return Object.freeze({ issuer, discoveryUrl, jwksUrl });
}

export type CatalogPrincipal =
  | {
      kind: 'user';
      subject: string;
      roles: readonly string[];
    }
  | {
      kind: 'service';
      subject: string;
      scopes: readonly string[];
      audiences: readonly string[];
    };

export interface CatalogAuthPolicy {
  marketplacePreviewRead?: boolean;
  demoRead?: boolean;
  restrictedDemo?: boolean;
  identity: 'user' | 'service' | 'either';
  scope?: string;
  allowedClients?: readonly string[];
  roles?: readonly string[];
}

export function RequireCatalogIdentity(
  policy: CatalogAuthPolicy,
): MethodDecorator & ClassDecorator {
  return SetMetadata(CATALOG_AUTH_POLICY, policy);
}

export class CatalogTokenRejected extends Error {}
export class CatalogSecurityUnavailable extends Error {}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface JwtClaims {
  iss?: unknown;
  sub?: unknown;
  iat?: unknown;
  exp?: unknown;
  nbf?: unknown;
  jti?: unknown;
  tipo?: unknown;
  aud?: unknown;
  scope?: unknown;
  roles?: unknown;
}

interface CachedKeys {
  keys: ReadonlyMap<string, KeyObject>;
  expiresAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodePart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function strings(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value;
  return undefined;
}

function audiences(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value;
  return undefined;
}

function cacheDuration(response: Response): number {
  const directive = response.headers
    .get('cache-control')
    ?.match(/(?:^|,)\s*max-age=(\d+)/i);
  const seconds = directive ? Number(directive[1]) : 60;
  return Math.max(0, Math.min(seconds, 300)) * 1000;
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';')[0] !== 'application/json'
  ) {
    await response.body?.cancel();
    throw new CatalogSecurityUnavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CatalogSecurityUnavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new CatalogSecurityUnavailable();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CatalogSecurityUnavailable();
  }
}

@Injectable()
export class CatalogTokenVerifier {
  private cache?: CachedKeys;
  private loading?: Promise<CachedKeys>;

  constructor(
    @Inject(CATALOG_SECURITY_CONFIG)
    private readonly config?: CatalogSecurityConfig,
  ) {}

  private async loadKeys(): Promise<CachedKeys> {
    if (!this.config) throw new CatalogSecurityUnavailable();
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache;
    // Share discovery/JWKS work during expiry, outages and rotation.
    // A failed fetch is never cached as a healthy key set.
    if (!this.loading) {
      this.loading = this.fetchKeys().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  private async fetchKeys(): Promise<CachedKeys> {
    if (!this.config) throw new CatalogSecurityUnavailable();

    try {
      const discoveryResponse = await fetch(this.config.discoveryUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      const discovery: unknown = await jsonResponse(discoveryResponse);
      if (
        !record(discovery) ||
        discovery.issuer !== this.config.issuer ||
        typeof discovery.jwks_uri !== 'string' ||
        new URL(discovery.jwks_uri).href !== new URL(this.config.jwksUrl).href
      )
        throw new CatalogSecurityUnavailable();

      const response = await fetch(this.config.jwksUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      const duration = cacheDuration(response);
      const set: unknown = await jsonResponse(response);
      if (!record(set) || !Array.isArray(set.keys))
        throw new CatalogSecurityUnavailable();

      const keys = new Map<string, KeyObject>();
      for (const value of set.keys) {
        if (
          !record(value) ||
          value.kty !== 'RSA' ||
          (value.use !== undefined && value.use !== 'sig') ||
          (value.alg !== undefined && value.alg !== 'RS256') ||
          typeof value.kid !== 'string' ||
          typeof value.n !== 'string' ||
          typeof value.e !== 'string'
        )
          continue;
        try {
          keys.set(
            value.kid,
            createPublicKey({ key: value as JsonWebKey, format: 'jwk' }),
          );
        } catch {
          // Ignore malformed or unsupported public keys in a rotating JWKS set.
        }
      }
      if (keys.size === 0) throw new CatalogSecurityUnavailable();
      this.cache = { keys, expiresAt: Date.now() + duration };
      return this.cache;
    } catch (error) {
      if (error instanceof CatalogSecurityUnavailable) throw error;
      throw new CatalogSecurityUnavailable();
    }
  }

  async verify(token: string): Promise<CatalogPrincipal> {
    const segments = token.split('.');
    if (
      segments.length !== 3 ||
      segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
    )
      throw new CatalogTokenRejected();
    let header: JwtHeader;
    let claims: JwtClaims;
    try {
      header = decodePart<JwtHeader>(segments[0]!);
      claims = decodePart<JwtClaims>(segments[1]!);
    } catch {
      throw new CatalogTokenRejected();
    }
    if (
      !record(header) ||
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !record(claims)
    )
      throw new CatalogTokenRejected();

    const keySet = await this.loadKeys();
    const key = keySet.keys.get(header.kid);
    if (!key) {
      this.cache = undefined;
      const refreshed = await this.loadKeys();
      const rotated = refreshed.keys.get(header.kid);
      if (!rotated) throw new CatalogTokenRejected();
      return this.verifySignatureAndClaims(segments, rotated, claims);
    }
    return this.verifySignatureAndClaims(segments, key, claims);
  }

  private verifySignatureAndClaims(
    segments: string[],
    key: KeyObject,
    claims: JwtClaims,
  ): CatalogPrincipal {
    if (
      !verifySignature(
        'RSA-SHA256',
        Buffer.from(segments[0] + '.' + segments[1]),
        key,
        Buffer.from(segments[2]!, 'base64url'),
      )
    )
      throw new CatalogTokenRejected();

    const now = Math.floor(Date.now() / 1000);
    if (
      !this.config ||
      claims.iss !== this.config.issuer ||
      typeof claims.sub !== 'string' ||
      typeof claims.iat !== 'number' ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now ||
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      typeof claims.jti !== 'string' ||
      claims.jti.length === 0 ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf > now))
    )
      throw new CatalogTokenRejected();

    if (claims.tipo === 'acceso') {
      const roles = strings(claims.roles);
      if (!UUID_PATTERN.test(claims.sub) || !roles)
        throw new CatalogTokenRejected();
      return { kind: 'user', subject: claims.sub, roles };
    }
    if (claims.tipo === 'servicio') {
      const tokenAudiences = audiences(claims.aud);
      const scopes = strings(claims.scope);
      if (!tokenAudiences || !scopes || !claims.sub)
        throw new CatalogTokenRejected();
      return {
        kind: 'service',
        subject: claims.sub,
        audiences: tokenAudiences,
        scopes,
      };
    }
    throw new CatalogTokenRejected();
  }
}

@Injectable()
export class CatalogAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: CatalogTokenVerifier,
    @Optional()
    @Inject(CATALOG_READ_DEMO)
    private readonly readDemo: CatalogReadDemo = { enabled: false },
    @Optional()
    @Inject(CATALOG_MARKETPLACE_PREVIEW)
    private readonly marketplacePreview = false,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<CatalogAuthPolicy>(
      CATALOG_AUTH_POLICY,
      [context.getHandler(), context.getClass()],
    );
    if (!policy) return true;
    const request = context.switchToHttp().getRequest<
      Request & {
        catalogPrincipal?: CatalogPrincipal;
        catalogDemoRead?: boolean;
        catalogDemoPreview?: boolean;
      }
    >();
    if (this.readDemo.restricted && policy.restrictedDemo) {
      const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (!peer || !this.readDemo.gatewayIps?.includes(peer))
        throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
      const correlation = request.headers['x-correlation-id'];
      new SanitizedLogger('runtime').log({
        code: 'CATALOG_RESTRICTED_DEMO_ACCESS',
        actor: 'restricted-demo:catalog-svc',
        operation: context.getHandler().name,
        correlationId:
          typeof correlation === 'string' && isCorrelationId(correlation)
            ? correlation
            : undefined,
      });
      // Explicit non-human access context; never a G7 principal or incoming identity.
      delete request.headers.authorization;
      Object.assign(request, { catalogRestrictedDemo: true });
      return true;
    }
    if (this.readDemo.enabled) {
      if (request.method === 'GET' && policy.demoRead) {
        request.catalogDemoRead = true;
        // An anonymous read is not a fabricated human/service identity.
        return true;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
        throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    }
    if (
      this.marketplacePreview &&
      request.method === 'GET' &&
      policy.marketplacePreviewRead &&
      request.query.canal === 'MARKETPLACE'
    ) {
      request.catalogDemoPreview = true;
      return true;
    }
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string' &&
      /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match) throw new UnauthorizedException({ code: 'TOKEN_INVALIDO' });

    let principal: CatalogPrincipal;
    try {
      principal = await this.verifier.verify(match[1]!);
    } catch (error) {
      if (error instanceof CatalogSecurityUnavailable)
        throw new ServiceUnavailableException({
          code: 'SERVICIO_NO_DISPONIBLE',
        });
      if (error instanceof CatalogTokenRejected)
        throw new UnauthorizedException({ code: 'TOKEN_INVALIDO' });
      throw new ServiceUnavailableException({
        code: 'SERVICIO_NO_DISPONIBLE',
      });
    }

    if (
      principal.kind === 'service' &&
      !principal.audiences.includes(SECURITY_AUDIENCE)
    )
      throw new UnauthorizedException({ code: 'TOKEN_INVALIDO' });

    if (
      (policy.identity === 'user' && principal.kind !== 'user') ||
      (policy.identity === 'service' && principal.kind !== 'service') ||
      (principal.kind === 'user' &&
        policy.roles &&
        !policy.roles.some((role) => principal.roles.includes(role))) ||
      (principal.kind === 'service' &&
        ((policy.scope !== undefined &&
          !principal.scopes.includes(policy.scope)) ||
          (policy.allowedClients !== undefined &&
            !policy.allowedClients.includes(principal.subject))))
    )
      throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });

    request.catalogPrincipal = principal;
    return true;
  }
}
