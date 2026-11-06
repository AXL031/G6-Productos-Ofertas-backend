import {
  CanActivate,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import type { Request } from 'express';

export const TAXONOMY_SECURITY_CONFIG = Symbol('TAXONOMY_SECURITY_CONFIG');
export const TAXONOMY_DEMO_ENABLED = Symbol('TAXONOMY_DEMO_ENABLED');
export const TAXONOMY_PUBLIC_READ_CONFIG = Symbol(
  'TAXONOMY_PUBLIC_READ_CONFIG',
);
export type TaxonomySecurityMode =
  'PUBLIC_READ_ONLY' | 'SIMULATED_AUTH' | 'G7_AUTHENTICATED';
export interface TaxonomyPublicReadConfig {
  readonly securityMode: TaxonomySecurityMode;
  readonly publicOperations: readonly string[];
}
const TAXONOMY_ELIGIBLE_PUBLIC_OPERATIONS = new Set([
  'listarCategorias',
  'listarMarcas',
]);
const TAXONOMY_SERVICE_READ = 'taxonomy:service-read';
const TAXONOMY_COMMERCIAL_USER_READ = 'taxonomy:commercial-user-read';
const TAXONOMY_SERVICE_CLIENTS = 'taxonomy:service-clients';
export const AllowTaxonomyServiceRead = () =>
  SetMetadata(TAXONOMY_SERVICE_READ, true);
export const AllowTaxonomyServiceClients = (...clients: string[]) =>
  SetMetadata(TAXONOMY_SERVICE_CLIENTS, Object.freeze([...clients]));
export const RequireTaxonomyCommercialUser = () =>
  SetMetadata(TAXONOMY_COMMERCIAL_USER_READ, true);
export function readTaxonomyPublicReadConfig(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): TaxonomyPublicReadConfig {
  const mode = env.G6_SECURITY_MODE;
  if (
    mode !== undefined &&
    !['PUBLIC_READ_ONLY', 'G7_AUTHENTICATED'].includes(mode)
  ) {
    throw new Error('Configuración de demo Taxonomy inválida');
  }
  const securityMode: TaxonomySecurityMode =
    (mode as TaxonomySecurityMode | undefined) ?? 'G7_AUTHENTICATED';
  const publicOperations = (env.TAXONOMY_PUBLIC_OPERATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    publicOperations.some((id) => !TAXONOMY_ELIGIBLE_PUBLIC_OPERATIONS.has(id))
  ) {
    throw new Error('Configuración de demo Taxonomy inválida');
  }
  if (securityMode !== 'PUBLIC_READ_ONLY' && publicOperations.length > 0) {
    throw new Error('Configuración de demo Taxonomy inválida');
  }
  return Object.freeze({
    securityMode,
    publicOperations: Object.freeze(publicOperations),
  });
}
export function readTaxonomyDemoConfig(
  env: Readonly<NodeJS.ProcessEnv>,
): boolean {
  readTaxonomyPublicReadConfig(env);
  const flag = env.ALLOW_DEMO_UNAUTHENTICATED;
  if (flag === undefined || flag === 'false') return false;
  if (
    flag !== 'true' ||
    !['test', 'development'].includes(env.NODE_ENV ?? '') ||
    env.G6_SECURITY_MODE !== undefined
  ) {
    throw new Error('Configuración de demo Taxonomy inválida');
  }
  return true;
}
const SECURITY_AUDIENCE = 'api-productos';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TaxonomySecurityConfig {
  issuer: string;
  discoveryUrl: string;
  jwksUrl: string;
}

export function readTaxonomySecurityConfig(
  env: Record<string, string | undefined> = process.env,
): TaxonomySecurityConfig | undefined {
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

export type TaxonomyPrincipal =
  | {
      kind: 'user';
      subject: string;
      roles: readonly string[];
      audiences: readonly string[];
    }
  | {
      kind: 'service';
      subject: string;
      scopes: readonly string[];
      audiences: readonly string[];
    };

export class TaxonomyTokenRejected extends Error {}
export class TaxonomySecurityUnavailable extends Error {}

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
    throw new TaxonomySecurityUnavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TaxonomySecurityUnavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new TaxonomySecurityUnavailable();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new TaxonomySecurityUnavailable();
  }
}

@Injectable()
export class TaxonomyTokenVerifier {
  private cache?: CachedKeys;
  private loading?: Promise<CachedKeys>;

  constructor(
    @Inject(TAXONOMY_SECURITY_CONFIG)
    private readonly config?: TaxonomySecurityConfig,
  ) {}

  private async loadKeys(): Promise<CachedKeys> {
    if (!this.config) throw new TaxonomySecurityUnavailable();
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
    if (!this.config) throw new TaxonomySecurityUnavailable();

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
        throw new TaxonomySecurityUnavailable();

      const response = await fetch(this.config.jwksUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      const duration = cacheDuration(response);
      const set: unknown = await jsonResponse(response);
      if (!record(set) || !Array.isArray(set.keys))
        throw new TaxonomySecurityUnavailable();

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
      if (keys.size === 0) throw new TaxonomySecurityUnavailable();
      this.cache = { keys, expiresAt: Date.now() + duration };
      return this.cache;
    } catch (error) {
      if (error instanceof TaxonomySecurityUnavailable) throw error;
      throw new TaxonomySecurityUnavailable();
    }
  }

  async verify(token: string): Promise<TaxonomyPrincipal> {
    const segments = token.split('.');
    if (
      segments.length !== 3 ||
      segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
    )
      throw new TaxonomyTokenRejected();
    let header: JwtHeader;
    let claims: JwtClaims;
    try {
      header = decodePart<JwtHeader>(segments[0]!);
      claims = decodePart<JwtClaims>(segments[1]!);
    } catch {
      throw new TaxonomyTokenRejected();
    }
    if (
      !record(header) ||
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !record(claims)
    )
      throw new TaxonomyTokenRejected();

    const keySet = await this.loadKeys();
    const key = keySet.keys.get(header.kid);
    if (!key) {
      this.cache = undefined;
      const refreshed = await this.loadKeys();
      const rotated = refreshed.keys.get(header.kid);
      if (!rotated) throw new TaxonomyTokenRejected();
      return this.verifySignatureAndClaims(segments, rotated, claims);
    }
    return this.verifySignatureAndClaims(segments, key, claims);
  }

  private verifySignatureAndClaims(
    segments: string[],
    key: KeyObject,
    claims: JwtClaims,
  ): TaxonomyPrincipal {
    if (
      !verifySignature(
        'RSA-SHA256',
        Buffer.from(segments[0] + '.' + segments[1]),
        key,
        Buffer.from(segments[2]!, 'base64url'),
      )
    )
      throw new TaxonomyTokenRejected();

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
      throw new TaxonomyTokenRejected();

    if (claims.tipo === 'acceso') {
      const roles = claims.roles === undefined ? [] : strings(claims.roles);
      if (!UUID_PATTERN.test(claims.sub) || !roles)
        throw new TaxonomyTokenRejected();
      return {
        kind: 'user',
        subject: claims.sub,
        roles,
        audiences: [],
      };
    }
    if (claims.tipo === 'servicio') {
      const tokenAudiences = audiences(claims.aud);
      const scopes = claims.scope === undefined ? [] : strings(claims.scope);
      if (!tokenAudiences || !scopes || !claims.sub)
        throw new TaxonomyTokenRejected();
      return {
        kind: 'service',
        subject: claims.sub,
        audiences: tokenAudiences,
        scopes,
      };
    }
    throw new TaxonomyTokenRejected();
  }
}

function isApprovedPublicTaxonomyOperation(
  handlerName: string | undefined,
  config: TaxonomyPublicReadConfig | undefined,
): boolean {
  if (!handlerName || config?.securityMode !== 'PUBLIC_READ_ONLY') return false;
  return (
    TAXONOMY_ELIGIBLE_PUBLIC_OPERATIONS.has(handlerName) &&
    config.publicOperations.includes(handlerName)
  );
}

@Injectable()
export class TaxonomyUserGuard implements CanActivate {
  constructor(
    private readonly verifier: TaxonomyTokenVerifier,
    @Optional()
    @Inject(TAXONOMY_PUBLIC_READ_CONFIG)
    private readonly publicReadConfig?: TaxonomyPublicReadConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    if (this.publicReadConfig?.securityMode === 'SIMULATED_AUTH')
      throw new ServiceUnavailableException();
    const match =
      typeof authorization === 'string' &&
      /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match) throw new UnauthorizedException();
    let principal: TaxonomyPrincipal;
    try {
      principal = await this.verifier.verify(match[1]!);
    } catch (error) {
      if (error instanceof TaxonomyTokenRejected)
        throw new UnauthorizedException();
      throw new ServiceUnavailableException();
    }
    if (principal.kind === 'service') {
      if (!principal.audiences.includes(SECURITY_AUDIENCE))
        throw new UnauthorizedException();
      if (
        request.method !== 'GET' ||
        Reflect.getMetadata(TAXONOMY_SERVICE_READ, context.getHandler()) !==
          true ||
        principal.subject !== 'modulo-productos' ||
        !principal.scopes.includes('catalogo:leer')
      )
        throw new ForbiddenException();
      return true;
    }
    if (
      Reflect.getMetadata(
        TAXONOMY_COMMERCIAL_USER_READ,
        context.getHandler(),
      ) === true &&
      !principal.roles.includes('GESTOR_COMERCIAL')
    )
      throw new ForbiddenException();
    (request as Request & { taxonomyUser?: TaxonomyPrincipal }).taxonomyUser =
      principal;
    return true;
  }
}

@Injectable()
export class TaxonomyCommercialGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const principal = context
      .switchToHttp()
      .getRequest<
        Request & { taxonomyUser?: TaxonomyPrincipal }
      >().taxonomyUser;
    if (
      !principal ||
      principal.kind !== 'user' ||
      !principal.roles.includes('GESTOR_COMERCIAL')
    )
      throw new ForbiddenException();
    return true;
  }
}

@Injectable()
export class TaxonomyAuthGuard implements CanActivate {
  constructor(
    private readonly verifier: TaxonomyTokenVerifier,
    @Inject(TAXONOMY_DEMO_ENABLED) private readonly demoEnabled: boolean,
    @Optional()
    @Inject(TAXONOMY_PUBLIC_READ_CONFIG)
    private readonly publicReadConfig?: TaxonomyPublicReadConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const peer = request.socket?.remoteAddress?.replace(/^::ffff:/, '');
    if (this.publicReadConfig?.securityMode === 'SIMULATED_AUTH')
      throw new ServiceUnavailableException();
    if (
      this.demoEnabled &&
      authorization === undefined &&
      request.method === 'GET' &&
      ['/api/v1/categorias', '/api/v1/marcas'].includes(request.path) &&
      (peer === '127.0.0.1' || peer === '::1')
    ) {
      return true;
    }
    const handlerName =
      context.getHandler?.()?.name ||
      (request.path === '/api/v1/categorias'
        ? 'listarCategorias'
        : request.path === '/api/v1/marcas'
          ? 'listarMarcas'
          : undefined);
    if (
      authorization === undefined &&
      request.method === 'GET' &&
      ['/api/v1/categorias', '/api/v1/marcas'].includes(request.path) &&
      isApprovedPublicTaxonomyOperation(handlerName, this.publicReadConfig)
    ) {
      return true;
    }
    const match =
      typeof authorization === 'string' &&
      /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match) throw new UnauthorizedException();
    let principal: TaxonomyPrincipal;
    try {
      principal = await this.verifier.verify(match[1]!);
    } catch (error) {
      if (error instanceof TaxonomyTokenRejected)
        throw new UnauthorizedException();
      throw new ServiceUnavailableException();
    }
    if (principal.kind !== 'service') throw new ForbiddenException();
    if (!principal.audiences.includes(SECURITY_AUDIENCE))
      throw new UnauthorizedException();
    if (!principal.scopes.includes('catalogo:leer'))
      throw new ForbiddenException();
    const allowedClients = Reflect.getMetadata(
      TAXONOMY_SERVICE_CLIENTS,
      context.getHandler(),
    ) as readonly string[] | undefined;
    if (!allowedClients?.includes(principal.subject))
      throw new ForbiddenException();
    return true;
  }
}
