import { CONTRACT_ROUTES } from './contract-routes.js';
import { PHASE1_INTERNAL_READ_ROUTES } from './phase1-internal-read-routes.js';
import { isEligiblePublicRead } from './gateway-public-reads.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const GATEWAY_SETTINGS = Symbol('GATEWAY_SETTINGS');
export type GatewaySecurityMode =
  'PUBLIC_READ_ONLY' | 'SIMULATED_AUTH' | 'G7_AUTHENTICATED';
export interface GatewaySettings {
  readonly upstreams: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly readinessPaths?: Readonly<Record<string, string>>;
  readonly issuer?: string;
  readonly jwksUrl?: string;
  readonly serviceTokenUrl?: string;
  readonly serviceClientSecret?: string;
  readonly publicOperations: readonly string[];
  readonly demoNoAuthEnabled: boolean;
  /** Compatibility with PR #125; this flag grants only its approved GET subset. */
  readonly readOnlyDemoEnabled?: boolean;
  readonly securityMode?: GatewaySecurityMode;
  readonly inventoryLocalGrantsEnabled?: boolean;
}

export function readGatewayPort(env: Readonly<NodeJS.ProcessEnv>): number {
  const raw = env.API_GATEWAY_PORT ?? env.PORT ?? '3000';
  const port = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    raw.trim() !== raw ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('Invalid Gateway port');
  }
  return port;
}

export function readGatewayEnvironment(cwd = process.cwd()): NodeJS.ProcessEnv {
  let files: NodeJS.ProcessEnv = {};
  try {
    for (const path of ['.env', 'apps/api-gateway/.env.local']) {
      const absolute = resolve(cwd, path);
      if (existsSync(absolute))
        files = { ...files, ...parseEnv(readFileSync(absolute, 'utf8')) };
    }
  } catch {
    throw new Error('Unable to read Gateway environment file');
  }
  return { ...files, ...process.env };
}

function origin(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid upstream origin');
  return url.origin;
}

export function readGatewaySettings(
  env: Readonly<NodeJS.ProcessEnv>,
): GatewaySettings {
  try {
    const upstreams: Record<string, string> = {};
    const readinessPaths: Record<string, string> = {};
    for (const service of new Set(CONTRACT_ROUTES.map((r) => r.service))) {
      const variable = `GATEWAY_${service.replaceAll('-', '_').toUpperCase()}_URL`;
      if (env[variable]) upstreams[service] = origin(env[variable]);
      const path = env[variable.replace(/_URL$/, '_READINESS_PATH')];
      if (path) {
        // A readiness endpoint must be explicitly confirmed by the owner.
        // Liveness paths cannot be used as successful readiness substitutes.
        if (
          !upstreams[service] ||
          !/^\/[a-zA-Z0-9_/-]+$/.test(path) ||
          path.startsWith('//') ||
          path.includes('//') ||
          ['/health', '/health/', '/health/live', '/health/live/'].includes(
            path,
          )
        )
          throw new Error();
        readinessPaths[service] = path;
      }
    }
    const timeoutMs = Number(env.GATEWAY_TIMEOUT_MS ?? '5000');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new Error();
    const demoNoAuthEnabled = env.GATEWAY_DEMO_NO_AUTH_ENABLED ?? 'false';
    const readOnlyDemoEnabled = env.G6_READ_ONLY_DEMO_ENABLED ?? 'false';
    if (!['true', 'false'].includes(demoNoAuthEnabled)) throw new Error();
    if (demoNoAuthEnabled === 'true') throw new Error();
    if (!['true', 'false'].includes(readOnlyDemoEnabled)) throw new Error();
    if (readOnlyDemoEnabled === 'true') throw new Error();
    if (
      env.G6_SECURITY_MODE !== undefined &&
      !['PUBLIC_READ_ONLY', 'SIMULATED_AUTH', 'G7_AUTHENTICATED'].includes(
        env.G6_SECURITY_MODE,
      )
    )
      throw new Error();
    const securityMode: GatewaySecurityMode =
      (env.G6_SECURITY_MODE as GatewaySecurityMode | undefined) ??
      'G7_AUTHENTICATED';
    if (
      env.G6_SECURITY_MODE !== undefined &&
      (demoNoAuthEnabled === 'true' || readOnlyDemoEnabled === 'true')
    )
      throw new Error();
    // The broad H4 mode and the legacy Catalog read-only mode are mutually
    // exclusive. Ambiguous configuration must never widen the read-only cap.
    if (demoNoAuthEnabled === 'true' && readOnlyDemoEnabled === 'true')
      throw new Error();
    const inventoryLocalGrants =
      env.GATEWAY_INVENTORY_LOCAL_GRANTS_ENABLED ?? 'false';
    if (!['true', 'false'].includes(inventoryLocalGrants)) throw new Error();
    const simulated = securityMode === 'SIMULATED_AUTH';
    const issuer = simulated ? env.SIMULATED_AUTH_ISSUER : env.AUTH_ISSUER;
    const jwksUrl = simulated ? env.SIMULATED_AUTH_JWKS_URL : env.AUTH_JWKS_URL;
    const serviceTokenUrl = simulated
      ? undefined
      : (env.GATEWAY_SERVICE_TOKEN_URL ??
        (issuer
          ? new URL('/api/v1/auth/token', new URL(issuer).origin).href
          : undefined));
    const serviceClientSecret = simulated
      ? undefined
      : env.GATEWAY_SERVICE_CLIENT_SECRET;
    if (!!issuer !== !!jwksUrl) throw new Error();
    if (simulated && (!issuer || !jwksUrl || issuer === env.AUTH_ISSUER))
      throw new Error();
    for (const value of [issuer, jwksUrl, serviceTokenUrl]) {
      if (!value) continue;
      const url = new URL(value);
      if (
        (url.protocol !== 'https:' &&
          !(
            env.NODE_ENV === 'test' &&
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    }
    const publicOperations = (env.GATEWAY_PUBLIC_OPERATION_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (
      publicOperations.some((id) =>
        securityMode === 'PUBLIC_READ_ONLY'
          ? ![...CONTRACT_ROUTES, ...PHASE1_INTERNAL_READ_ROUTES].some(
              (r) => r.operationId === id && isEligiblePublicRead(r),
            )
          : true,
      )
    )
      throw new Error();
    return Object.freeze({
      upstreams: Object.freeze(upstreams),
      readinessPaths: Object.freeze(readinessPaths),
      timeoutMs,
      maxBytes: 10 * 1024 * 1024,
      issuer,
      jwksUrl,
      serviceTokenUrl,
      serviceClientSecret,
      publicOperations: Object.freeze(publicOperations),
      demoNoAuthEnabled: demoNoAuthEnabled === 'true',
      readOnlyDemoEnabled: readOnlyDemoEnabled === 'true',
      securityMode,
      inventoryLocalGrantsEnabled: inventoryLocalGrants === 'true',
    });
  } catch {
    throw new Error(
      'Invalid Gateway configuration; review upstream origins, auth configuration and public operation allowlist',
    );
  }
}
