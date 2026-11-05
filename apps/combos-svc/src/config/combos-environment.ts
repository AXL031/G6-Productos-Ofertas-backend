import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { PoolConfig } from 'pg';

export interface CombosEnvironment {
  readonly host: string;
  readonly port: number;
  readonly demoEnabled: boolean;
  readonly demoGatewayIps: readonly string[];
  readonly securityMode:
    'PUBLIC_READ_ONLY' | 'SIMULATED_AUTH' | 'G7_AUTHENTICATED';
  readonly pool: PoolConfig;
}

function validHost(value: string): boolean {
  return (
    isIP(value) !== 0 ||
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
  );
}

function allowedHttpUrl(url: URL, internalService: boolean): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        (internalService &&
          (url.hostname.endsWith('-svc') || url.hostname.endsWith('.svc')))))
  );
}

export function readCombosEnvironment(
  env: NodeJS.ProcessEnv,
): CombosEnvironment {
  const errors: string[] = [];
  const rawPort = env.COMBOS_SVC_PORT ?? env.PORT ?? '3007';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    errors.push('COMBOS_SVC_PORT');
  const host = env.COMBOS_SVC_HOST ?? '0.0.0.0';
  if (!validHost(host)) errors.push('COMBOS_SVC_HOST');
  const securityMode = env.G6_SECURITY_MODE ?? 'G7_AUTHENTICATED';
  if (
    !['PUBLIC_READ_ONLY', 'SIMULATED_AUTH', 'G7_AUTHENTICATED'].includes(
      securityMode,
    )
  )
    errors.push('G6_SECURITY_MODE');
  const demoEnabled = env.COMBOS_RESTRICTED_DEMO_ENABLED === 'true';
  const demoGatewayIps = (env.COMBOS_RESTRICTED_DEMO_GATEWAY_IPS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (
    demoGatewayIps.some((address) => isIP(address) === 0) ||
    (demoEnabled && demoGatewayIps.length === 0)
  )
    errors.push('COMBOS_RESTRICTED_DEMO_GATEWAY_IPS');
  if (
    env.COMBOS_RESTRICTED_DEMO_ENABLED !== undefined &&
    !['true', 'false'].includes(env.COMBOS_RESTRICTED_DEMO_ENABLED)
  )
    errors.push('COMBOS_RESTRICTED_DEMO_ENABLED');
  if (
    demoEnabled &&
    (env.COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED !== 'true' ||
      (env.NODE_ENV === 'production' &&
        env.COMBOS_RESTRICTED_DEMO_PRODUCTION_CONFIRMED !== 'true'))
  )
    errors.push('COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    errors.push('NODE_TLS_REJECT_UNAUTHORIZED');
  if (
    (env.COMBOS_TEST_EPHEMERAL !== undefined &&
      env.COMBOS_TEST_EPHEMERAL !== '1') ||
    (env.COMBOS_TEST_EPHEMERAL === '1' && env.NODE_ENV !== 'test')
  )
    errors.push('COMBOS_TEST_EPHEMERAL is restricted to NODE_ENV=test');

  for (const key of [
    'COMBOS_AMQP_ENABLED',
    'COMBOS_CATALOG_CONTEXT_AUTHORIZED',
  ]) {
    if (env[key] !== undefined && !['true', 'false'].includes(env[key]!))
      errors.push(key);
  }
  if (
    (env.COMBOS_G7_TOKEN_URL === undefined) !==
    (env.COMBOS_G7_CLIENT_SECRET === undefined)
  )
    errors.push('COMBOS_G7_TOKEN_URL/COMBOS_G7_CLIENT_SECRET');
  const securityValues = [
    env.SECURITY_ISSUER,
    env.SECURITY_DISCOVERY_URL,
    env.SECURITY_JWKS_URL,
  ];
  const simulatedValues = [
    env.COMBOS_SIMULATED_ISSUER,
    env.COMBOS_SIMULATED_DISCOVERY_URL,
    env.COMBOS_SIMULATED_JWKS_URL,
  ];
  if (
    securityMode === 'SIMULATED_AUTH' &&
    simulatedValues.some((value) => !value?.trim())
  )
    errors.push('COMBOS_SIMULATED_ISSUER/DISCOVERY_URL/JWKS_URL');
  if (
    simulatedValues.some((value) => value !== undefined) &&
    simulatedValues.some((value) => !value?.trim())
  )
    errors.push('COMBOS_SIMULATED_ISSUER/DISCOVERY_URL/JWKS_URL');
  if (
    securityMode === 'SIMULATED_AUTH' &&
    env.COMBOS_SIMULATED_ISSUER?.trim() === env.SECURITY_ISSUER?.trim()
  )
    errors.push('COMBOS_SIMULATED_ISSUER must be independent from G7');
  if (
    securityValues.some((value) => value !== undefined) &&
    securityValues.some((value) => !value?.trim())
  )
    errors.push('SECURITY_ISSUER/SECURITY_DISCOVERY_URL/SECURITY_JWKS_URL');
  if (
    securityMode === 'G7_AUTHENTICATED' &&
    securityValues.some((value) => !value?.trim())
  )
    errors.push('SECURITY_ISSUER/SECURITY_DISCOVERY_URL/SECURITY_JWKS_URL');
  if (
    (env.COMBOS_G7_TOKEN_URL !== undefined ||
      env.COMBOS_G7_CLIENT_SECRET !== undefined) &&
    securityValues.some((value) => !value?.trim())
  )
    errors.push(
      'COMBOS_G7_TOKEN_URL requires G7 issuer, discovery and JWKS configuration',
    );
  for (const key of [
    'COMBOS_CATALOG_URL',
    'COMBOS_PRICING_URL',
    'COMBOS_G7_TOKEN_URL',
    'SECURITY_ISSUER',
    'SECURITY_DISCOVERY_URL',
    'SECURITY_JWKS_URL',
    'COMBOS_SIMULATED_ISSUER',
    'COMBOS_SIMULATED_DISCOVERY_URL',
    'COMBOS_SIMULATED_JWKS_URL',
  ]) {
    const value = env[key]?.trim();
    if (!value) {
      if (env[key] !== undefined) errors.push(key);
      continue;
    }
    try {
      const url = new URL(value);
      if (
        !allowedHttpUrl(
          url,
          key === 'COMBOS_CATALOG_URL' || key === 'COMBOS_PRICING_URL',
        ) ||
        url.username ||
        url.password ||
        url.hash
      )
        errors.push(key);
    } catch {
      errors.push(key);
    }
  }
  if (env.COMBOS_AMQP_ENABLED === 'true') {
    try {
      const url = new URL(env.COMBOS_AMQP_URL ?? '');
      if (
        !['amqp:', 'amqps:'].includes(url.protocol) ||
        !url.hostname ||
        url.pathname === '/' ||
        url.hash
      )
        errors.push('COMBOS_AMQP_URL');
    } catch {
      errors.push('COMBOS_AMQP_URL');
    }
  }

  const required = [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
    'PGSSLROOTCERT',
  ];
  for (const key of required) if (!env[key]?.trim()) errors.push(key);
  const pgPort = Number(env.PGPORT);
  if (env.PGHOST && !validHost(env.PGHOST)) errors.push('PGHOST');
  if (env.G6_CONNECT_HOST && !validHost(env.G6_CONNECT_HOST))
    errors.push('G6_CONNECT_HOST');
  if (env.PGSSLMODE && env.PGSSLMODE !== 'verify-full')
    errors.push('PGSSLMODE');
  if (!Number.isInteger(pgPort) || pgPort < 1 || pgPort > 65535)
    errors.push('PGPORT');
  if (env.PGSSLROOTCERT && !isAbsolute(env.PGSSLROOTCERT))
    errors.push('PGSSLROOTCERT');
  let ca = '';
  if (env.PGSSLROOTCERT && isAbsolute(env.PGSSLROOTCERT)) {
    try {
      ca = readFileSync(env.PGSSLROOTCERT, 'utf8');
    } catch {
      errors.push('PGSSLROOTCERT');
    }
    if (ca && !ca.includes('-----BEGIN CERTIFICATE-----'))
      errors.push('PGSSLROOTCERT');
  }
  if (errors.length)
    throw new Error(
      `Configuración combos-svc inválida: ${[...new Set(errors)].join(', ')}`,
    );
  const databaseHost = env.PGHOST!;
  return {
    host,
    port,
    demoEnabled,
    demoGatewayIps,
    securityMode: securityMode as CombosEnvironment['securityMode'],
    pool: {
      host: env.G6_CONNECT_HOST || databaseHost,
      port: pgPort,
      database: env.PGDATABASE!,
      user: env.PGUSER!,
      password: env.PGPASSWORD!,
      ssl: {
        ca,
        rejectUnauthorized: true,
        ...(isIP(databaseHost) ? {} : { servername: databaseHost }),
        checkServerIdentity: (_host, cert) =>
          checkServerIdentity(databaseHost, cert),
      },
      max: 4,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      statement_timeout: 10000,
      query_timeout: 10000,
    },
  };
}
