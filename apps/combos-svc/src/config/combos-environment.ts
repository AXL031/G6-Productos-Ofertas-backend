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
  readonly pool: PoolConfig;
}

function validHost(value: string): boolean {
  return (
    isIP(value) !== 0 ||
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
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
