import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { internalOrigin, type Upstream } from '../http/internal-http.js';
const upstreamVariables = {
  catalog: 'GATEWAY_CATALOG_SVC_URL',
  pricing: 'GATEWAY_PRICING_SVC_URL',
  inventory: 'GATEWAY_INVENTORY_SVC_URL',
  taxonomy: 'GATEWAY_TAXONOMY_SVC_URL',
} as const;

const requiredVariables = [
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'G6_DATABASE_SCHEMA',
  'G6_CONNECTION_MODE',
  'RABBITMQ_URL',
] as const;

type ConfigurationVariable =
  | (typeof requiredVariables)[number]
  | 'NODE_ENV'
  | 'PROMOTIONS_SVC_PORT'
  | 'PORT'
  | 'PROMOTIONS_DEPENDENCY_PROBES_ENABLED'
  | 'PROMOTIONS_COUPON_RUNTIME_ENABLED'
  | 'GATEWAY_DEMO_NO_AUTH_ENABLED'
  | 'AUTH_ISSUER'
  | 'AUTH_JWKS_URL'
  | 'PROMOTIONS_SERVICE_TOKEN_URL'
  | 'PROMOTIONS_SERVICE_CLIENT_SECRET'
  | 'ENV_FILE';

export class PromotionsConfigurationError extends Error {
  constructor(
    readonly variables: readonly (
      ConfigurationVariable | (typeof upstreamVariables)[Upstream]
    )[],
  ) {
    super(`Invalid promotions-svc configuration: ${variables.join(', ')}`);
    this.name = 'PromotionsConfigurationError';
  }
}

export interface PromotionsConfiguration {
  readonly environment: 'development' | 'test' | 'production';
  readonly port: number;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly sslMode: 'verify-full';
    readonly sslRootCert: string;
    readonly schema: 'promotions';
    readonly connectionMode: 'session';
  };
  readonly rabbitmqUrl: string;
  readonly dependencyProbesEnabled: boolean;
  readonly couponRuntimeEnabled: boolean;
  readonly localDemoEnabled: boolean;
  readonly listenHost: '127.0.0.1' | '0.0.0.0' | '::';
  readonly auth?: Readonly<{ issuer: string; jwksUrl: string }>;
  readonly serviceCredentials?: Readonly<{
    tokenUrl: string;
    clientSecret: string;
  }>;
  readonly upstreams: Readonly<Partial<Record<Upstream, string>>>;
}

function isPort(value: string): boolean {
  return (
    value.trim() === value &&
    /^\d+$/.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= 65535
  );
}

export function validatePromotionsConfiguration(
  environment: Readonly<NodeJS.ProcessEnv>,
): PromotionsConfiguration {
  const invalid = new Set<
    ConfigurationVariable | (typeof upstreamVariables)[Upstream]
  >();
  let auth: PromotionsConfiguration['auth'];
  let serviceCredentials: PromotionsConfiguration['serviceCredentials'];
  if (
    environment.AUTH_ISSUER !== undefined ||
    environment.AUTH_JWKS_URL !== undefined
  ) {
    for (const name of ['AUTH_ISSUER', 'AUTH_JWKS_URL'] as const) {
      try {
        const url = new URL(environment[name] ?? '');
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          environment[name]?.trim() !== environment[name]
        )
          invalid.add(name);
      } catch {
        invalid.add(name);
      }
    }
    if (!invalid.has('AUTH_ISSUER') && !invalid.has('AUTH_JWKS_URL'))
      auth = Object.freeze({
        issuer: environment.AUTH_ISSUER!,
        jwksUrl: environment.AUTH_JWKS_URL!,
      });
  }
  if (
    environment.PROMOTIONS_SERVICE_TOKEN_URL !== undefined ||
    environment.PROMOTIONS_SERVICE_CLIENT_SECRET !== undefined
  ) {
    try {
      const tokenUrl = environment.PROMOTIONS_SERVICE_TOKEN_URL ?? '';
      const clientSecret = environment.PROMOTIONS_SERVICE_CLIENT_SECRET ?? '';
      const url = new URL(tokenUrl);
      if (
        !auth ||
        url.origin !== new URL(auth.issuer).origin ||
        url.protocol !== 'https:' ||
        url.pathname !== '/api/v1/auth/token' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        tokenUrl.trim() !== tokenUrl ||
        !clientSecret.trim() ||
        /[\r\n\0]/.test(clientSecret)
      )
        throw new Error();
      serviceCredentials = Object.freeze({ tokenUrl: url.href, clientSecret });
    } catch {
      invalid.add('PROMOTIONS_SERVICE_TOKEN_URL');
      invalid.add('PROMOTIONS_SERVICE_CLIENT_SECRET');
    }
  }
  const enabled = (name: ConfigurationVariable): boolean => {
    const value = environment[name] ?? 'false';
    if (!['true', 'false'].includes(value)) invalid.add(name);
    return value === 'true';
  };
  const dependencyProbesEnabled = enabled(
    'PROMOTIONS_DEPENDENCY_PROBES_ENABLED',
  );
  const couponRuntimeEnabled = enabled('PROMOTIONS_COUPON_RUNTIME_ENABLED');
  const localDemoEnabled = enabled('GATEWAY_DEMO_NO_AUTH_ENABLED');
  const upstreams: Partial<Record<Upstream, string>> = {};
  for (const service of Object.keys(upstreamVariables) as Upstream[]) {
    const variable = upstreamVariables[service],
      value = environment[variable];
    if (value === undefined) continue;
    try {
      if (value.trim() !== value) throw new Error();
      upstreams[service] = internalOrigin(value, localDemoEnabled, service);
    } catch {
      invalid.add(variable);
    }
  }
  // Explicit activation only. Production additionally requires the independently
  // verified private Gateway perimeter; the guard checks its actual TCP peer.
  if (
    localDemoEnabled &&
    environment.NODE_ENV !== 'development' &&
    environment.NODE_ENV !== 'test' &&
    environment.NODE_ENV !== 'production'
  )
    invalid.add('GATEWAY_DEMO_NO_AUTH_ENABLED');
  const required = Object.fromEntries(
    requiredVariables.map((name) => {
      const value = environment[name] ?? '';
      if (!value.trim() || value.includes('\0')) invalid.add(name);
      return [name, value];
    }),
  ) as Record<(typeof requiredVariables)[number], string>;

  const nodeEnvironment = environment.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnvironment)) {
    invalid.add('NODE_ENV');
  }
  const portVariable =
    environment.PROMOTIONS_SVC_PORT !== undefined
      ? 'PROMOTIONS_SVC_PORT'
      : 'PORT';
  const rawPort = environment[portVariable] ?? '3004';
  if (!isPort(rawPort)) invalid.add(portVariable);
  if (!isPort(required.PGPORT)) invalid.add('PGPORT');
  if (
    required.PGHOST.trim() !== required.PGHOST ||
    !/^[a-zA-Z0-9.-]+$/.test(required.PGHOST)
  ) {
    invalid.add('PGHOST');
  }
  if (required.PGSSLMODE !== 'verify-full') invalid.add('PGSSLMODE');
  if (required.G6_DATABASE_SCHEMA !== 'promotions') {
    invalid.add('G6_DATABASE_SCHEMA');
  }
  if (required.G6_CONNECTION_MODE !== 'session') {
    invalid.add('G6_CONNECTION_MODE');
  }
  try {
    if (
      !isAbsolute(required.PGSSLROOTCERT) ||
      !statSync(required.PGSSLROOTCERT).isFile()
    ) {
      invalid.add('PGSSLROOTCERT');
    } else {
      new X509Certificate(readFileSync(required.PGSSLROOTCERT));
    }
  } catch {
    invalid.add('PGSSLROOTCERT');
  }
  try {
    const broker = new URL(required.RABBITMQ_URL);
    if (
      !['amqp:', 'amqps:'].includes(broker.protocol) ||
      /\s/.test(required.RABBITMQ_URL) ||
      !broker.hostname ||
      (broker.port !== '' && !isPort(broker.port)) ||
      broker.search ||
      broker.hash
    ) {
      invalid.add('RABBITMQ_URL');
    }
  } catch {
    invalid.add('RABBITMQ_URL');
  }

  if (invalid.size) throw new PromotionsConfigurationError([...invalid]);

  return Object.freeze({
    environment: nodeEnvironment as PromotionsConfiguration['environment'],
    port: Number(rawPort),
    database: Object.freeze({
      host: required.PGHOST,
      port: Number(required.PGPORT),
      database: required.PGDATABASE,
      user: required.PGUSER,
      password: required.PGPASSWORD,
      sslMode: 'verify-full' as const,
      sslRootCert: required.PGSSLROOTCERT,
      schema: 'promotions' as const,
      connectionMode: 'session' as const,
    }),
    rabbitmqUrl: required.RABBITMQ_URL,
    dependencyProbesEnabled,
    couponRuntimeEnabled,
    localDemoEnabled,
    listenHost: localDemoEnabled
      ? nodeEnvironment === 'production'
        ? '0.0.0.0'
        : '127.0.0.1'
      : '::',
    auth,
    serviceCredentials,
    upstreams: Object.freeze(upstreams),
  });
}

export function readPromotionsEnvironment(
  cwd = process.cwd(),
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  let files: NodeJS.ProcessEnv = {};
  try {
    for (const path of ['.env', 'apps/promotions-svc/.env.local']) {
      const absolutePath = resolve(cwd, path);
      if (existsSync(absolutePath)) {
        files = { ...files, ...parseEnv(readFileSync(absolutePath, 'utf8')) };
      }
    }
  } catch {
    throw new PromotionsConfigurationError(['ENV_FILE']);
  }
  return { ...files, ...environment };
}

export class PromotionsConfigService {
  constructor(readonly settings: PromotionsConfiguration) {}

  // Accidental serialization must not disclose credentials or local paths.
  toJSON() {
    return {
      environment: this.settings.environment,
      port: this.settings.port,
      schema: this.settings.database.schema,
    };
  }
}
