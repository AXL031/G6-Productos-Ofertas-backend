import {
  CanActivate,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import type { Request } from 'express';
import { isAllowedDemoGatewayIp } from './combos-demo-origin.js';

const AUDIENCE = 'api-productos';
const POLICY = Symbol('COMBO_ACCESS_POLICY');
const PUBLIC_READ_APPROVALS = new Set<string>();
const PUBLIC_READ_ROUTES: Readonly<
  Record<string, { method: string; path: string }>
> = {
  obtenerCombo: { method: 'GET', path: '/combos/:comboId' },
  consultarDisponibilidadCombo: {
    method: 'GET',
    path: '/combos/:comboId/disponibilidad',
  },
};
const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ComboAccessPolicy {
  operationId: string;
  identity: 'user' | 'service' | 'user_or_service';
  scope?: string;
  allowedClients?: readonly string[];
  allowedRoles?: readonly string[];
}

export function RequireComboAccess(policy: ComboAccessPolicy): MethodDecorator {
  return SetMetadata(POLICY, policy);
}

export class ComboTokenRejected extends Error {}
export class ComboIdentityUnavailable extends Error {}

interface SecurityConfig {
  issuer: string;
  discoveryUrl: string;
  jwksUrl: string;
}
interface Principal {
  kind: 'user' | 'service';
  subject: string;
  roles: string[];
  scopes: string[];
  audiences: string[];
}
interface KeySet {
  keys: ReadonlyMap<string, KeyObject>;
  expiresAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value;
  return undefined;
}
function audienceList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value;
  return undefined;
}
async function readJson(response: Response): Promise<unknown> {
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
      'application/json'
  ) {
    await response.body?.cancel();
    throw new ComboIdentityUnavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ComboIdentityUnavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new ComboIdentityUnavailable();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ComboIdentityUnavailable();
  }
}

@Injectable()
export class ComboTokenVerifier {
  private readonly config: SecurityConfig | undefined;
  private cache?: KeySet;
  private loading?: Promise<KeySet>;

  protected environmentPrefix(): string {
    return 'SECURITY';
  }

  constructor() {
    const env = process.env;
    const prefix = this.environmentPrefix();
    const values = [
      env[`${prefix}_ISSUER`],
      env[`${prefix}_DISCOVERY_URL`],
      env[`${prefix}_JWKS_URL`],
    ];
    if (values.every((value) => value === undefined || value.trim() === '')) {
      this.config = undefined;
      return;
    }
    if (values.some((value) => !value?.trim()))
      throw new Error(
        'SECURITY_ISSUER, SECURITY_DISCOVERY_URL y SECURITY_JWKS_URL deben configurarse juntos',
      );
    const issuer = values[0]!.trim();
    const discoveryUrl = values[1]!.trim();
    const jwksUrl = values[2]!.trim();
    for (const value of [issuer, discoveryUrl, jwksUrl]) {
      const url = new URL(value);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol === 'http:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        throw new Error('Configuración de identidad Combos inválida');
    }
    this.config = { issuer, discoveryUrl, jwksUrl };
  }

  private loadKeys(): Promise<KeySet> {
    if (!this.config) return Promise.reject(new ComboIdentityUnavailable());
    if (this.cache && this.cache.expiresAt > Date.now())
      return Promise.resolve(this.cache);
    if (!this.loading)
      this.loading = this.fetchKeys().finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  private async fetchKeys(): Promise<KeySet> {
    const config = this.config;
    if (!config) throw new ComboIdentityUnavailable();
    try {
      const discoveryResponse = await fetch(config.discoveryUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      const discovery = await readJson(discoveryResponse);
      if (
        !record(discovery) ||
        discovery.issuer !== config.issuer ||
        typeof discovery.jwks_uri !== 'string' ||
        new URL(discovery.jwks_uri).href !== new URL(config.jwksUrl).href
      )
        throw new ComboIdentityUnavailable();
      const response = await fetch(config.jwksUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      const cacheAge = response.headers
        .get('cache-control')
        ?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
      const seconds = Math.max(0, Math.min(Number(cacheAge ?? 60), 300));
      const jwks = await readJson(response);
      if (!record(jwks) || !Array.isArray(jwks.keys))
        throw new ComboIdentityUnavailable();
      const keys = new Map<string, KeyObject>();
      for (const item of jwks.keys) {
        if (
          !record(item) ||
          item.kty !== 'RSA' ||
          (item.use !== undefined && item.use !== 'sig') ||
          (item.alg !== undefined && item.alg !== 'RS256') ||
          typeof item.kid !== 'string' ||
          typeof item.n !== 'string' ||
          typeof item.e !== 'string'
        )
          continue;
        try {
          keys.set(
            item.kid,
            createPublicKey({ key: item as JsonWebKey, format: 'jwk' }),
          );
        } catch {
          // Unsupported keys in a rotating set do not invalidate valid keys.
        }
      }
      if (keys.size === 0) throw new ComboIdentityUnavailable();
      this.cache = { keys, expiresAt: Date.now() + seconds * 1000 };
      return this.cache;
    } catch (error) {
      if (error instanceof ComboIdentityUnavailable) throw error;
      throw new ComboIdentityUnavailable();
    }
  }

  async verify(token: string): Promise<Principal> {
    const segments = token.split('.');
    if (
      segments.length !== 3 ||
      segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new ComboTokenRejected();
    let header: unknown;
    let claims: unknown;
    try {
      header = JSON.parse(Buffer.from(segments[0]!, 'base64url').toString());
      claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString());
    } catch {
      throw new ComboTokenRejected();
    }
    if (
      !record(header) ||
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !record(claims)
    )
      throw new ComboTokenRejected();
    const keySet = await this.loadKeys();
    let key = keySet.keys.get(header.kid);
    if (!key) {
      this.cache = undefined;
      key = (await this.loadKeys()).keys.get(header.kid);
    }
    if (
      !key ||
      !verifySignature(
        'RSA-SHA256',
        Buffer.from(`${segments[0]}.${segments[1]}`),
        key,
        Buffer.from(segments[2]!, 'base64url'),
      )
    )
      throw new ComboTokenRejected();
    const now = Math.floor(Date.now() / 1000);
    const config = this.config;
    if (
      !config ||
      claims.iss !== config.issuer ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.iat !== 'number' ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now ||
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      typeof claims.jti !== 'string' ||
      !claims.jti ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf > now))
    )
      throw new ComboTokenRejected();
    const audiences = audienceList(claims.aud);
    if (!audiences?.includes(AUDIENCE)) throw new ComboTokenRejected();
    if (claims.tipo === 'acceso') {
      const roles = stringList(claims.roles);
      if (!USER_ID.test(claims.sub) || !roles) throw new ComboTokenRejected();
      return {
        kind: 'user',
        subject: claims.sub,
        roles,
        scopes: [],
        audiences,
      };
    }
    if (claims.tipo === 'servicio') {
      const scopes = stringList(claims.scope);
      if (!scopes) throw new ComboTokenRejected();
      return {
        kind: 'service',
        subject: claims.sub,
        roles: [],
        scopes,
        audiences,
      };
    }
    throw new ComboTokenRejected();
  }
}

@Injectable()
export class SimulatedComboTokenVerifier extends ComboTokenVerifier {
  protected override environmentPrefix(): string {
    return 'COMBOS_SIMULATED';
  }
}

@Injectable()
export class CombosAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly g7Verifier: ComboTokenVerifier,
    private readonly simulatedVerifier: SimulatedComboTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.get<ComboAccessPolicy>(
      POLICY,
      context.getHandler(),
    );
    if (!policy) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const mode = process.env.G6_SECURITY_MODE ?? 'G7_AUTHENTICATED';
    const exactRead =
      (policy.operationId === 'obtenerCombo' &&
        request.method === 'GET' &&
        request.route.path === '/combos/:comboId') ||
      (policy.operationId === 'consultarDisponibilidadCombo' &&
        request.method === 'GET' &&
        request.route.path === '/combos/:comboId/disponibilidad');
    const configuredPublicReads = new Set(
      (process.env.COMBOS_PUBLIC_READ_OPERATIONS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
    // A public phase only adds explicitly approved anonymous operations.
    // Protected operations keep the same authentication/authorization path.
    if (process.env.COMBOS_RESTRICTED_DEMO_ENABLED === 'true') {
      if (
        !isAllowedDemoGatewayIp(
          request.socket.remoteAddress,
          (process.env.COMBOS_RESTRICTED_DEMO_GATEWAY_IPS ?? '')
            .split(',')
            .map((address) => address.trim())
            .filter(Boolean),
        )
      )
        throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    }
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string' &&
      /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match) {
      const route = PUBLIC_READ_ROUTES[policy.operationId];
      if (
        mode === 'PUBLIC_READ_ONLY' &&
        exactRead &&
        route &&
        PUBLIC_READ_APPROVALS.has(policy.operationId) &&
        configuredPublicReads.has(policy.operationId) &&
        request.method === route.method &&
        request.route.path === route.path
      )
        return true;
      throw new UnauthorizedException({ code: 'TOKEN_INVALIDO' });
    }
    let principal: Principal;
    try {
      principal = await (
        mode === 'SIMULATED_AUTH' ? this.simulatedVerifier : this.g7Verifier
      ).verify(match[1]!);
    } catch (error) {
      if (error instanceof ComboIdentityUnavailable)
        throw new ServiceUnavailableException({
          code: 'SERVICIO_NO_DISPONIBLE',
        });
      throw new UnauthorizedException({ code: 'TOKEN_INVALIDO' });
    }
    if (
      policy.identity !== 'user_or_service' &&
      principal.kind !== policy.identity
    )
      throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    if (policy.identity === 'user_or_service' && principal.kind === 'service') {
      const allowedClients = (
        process.env.COMBOS_ALLOWED_CLIENTS_COMBOS_READ ?? ''
      )
        .split(',')
        .map((client) => client.trim())
        .filter(Boolean);
      if (
        !policy.scope ||
        !principal.scopes.includes(policy.scope) ||
        !allowedClients.includes(principal.subject)
      )
        throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    }
    if (
      policy.scope &&
      principal.kind === 'service' &&
      !principal.scopes.includes(policy.scope)
    )
      throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    if (
      principal.kind === 'service' &&
      policy.identity === 'service' &&
      !policy.allowedClients?.includes(principal.subject)
    )
      throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    if (principal.kind === 'user') {
      const roleKey = `COMBOS_ALLOWED_ROLES_${policy.operationId
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toUpperCase()}`;
      const configuredRoles = (process.env[roleKey] ?? '')
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean);
      const allowedRoles = policy.allowedRoles ?? configuredRoles;
      if (
        allowedRoles.length === 0 ||
        !allowedRoles.some((role) => principal.roles.includes(role))
      )
        throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    }
    return true;
  }
}
