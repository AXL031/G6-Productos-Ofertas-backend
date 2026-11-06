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
  | 'G6_SECURITY_MODE'
  | 'SIMULATED_AUTH_ISSUER'
  | 'SIMULATED_AUTH_JWKS_URL'
  | 'PROMOTIONS_PUBLIC_OPERATION_IDS'
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
  readonly securityMode:
    'PUBLIC_READ_ONLY' | 'SIMULATED_AUTH' | 'G7_AUTHENTICATED';
  readonly publicOperations: readonly string[];
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
  const securityMode = environment.G6_SECURITY_MODE ?? 'G7_AUTHENTICATED';
  if (
    !['PUBLIC_READ_ONLY', 'SIMULATED_AUTH', 'G7_AUTHENTICATED'].includes(
      securityMode,
    )
  )
    invalid.add('G6_SECURITY_MODE');
  const publicOperations = (environment.PROMOTIONS_PUBLIC_OPERATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    publicOperations.some((id) => id !== 'listarPromociones') ||
    (securityMode !== 'PUBLIC_READ_ONLY' && publicOperations.length)
  )
    invalid.add('PROMOTIONS_PUBLIC_OPERATION_IDS');
  const selectedIssuer =
    securityMode === 'SIMULATED_AUTH'
      ? environment.SIMULATED_AUTH_ISSUER
      : environment.AUTH_ISSUER;
  const selectedJwks =
    securityMode === 'SIMULATED_AUTH'
      ? environment.SIMULATED_AUTH_JWKS_URL
      : environment.AUTH_JWKS_URL;
  if (
    securityMode === 'SIMULATED_AUTH' &&
    (!selectedIssuer ||
      !selectedJwks ||
      selectedIssuer === environment.AUTH_ISSUER)
  ) {
    invalid.add('SIMULATED_AUTH_ISSUER');
    invalid.add('SIMULATED_AUTH_JWKS_URL');
  }
  let auth: PromotionsConfiguration['auth'];
  let serviceCredentials: PromotionsConfiguration['serviceCredentials'];
  if (selectedIssuer !== undefined || selectedJwks !== undefined) {
    for (const [name, value] of [
      ['AUTH_ISSUER', selectedIssuer],
      ['AUTH_JWKS_URL', selectedJwks],
    ] as const) {
      try {
        const url = new URL(value ?? '');
        if (
          (url.protocol !== 'https:' &&
            !(
              environment.NODE_ENV === 'test' &&
              url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            )) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          value?.trim() !== value
        )
          invalid.add(name);
      } catch {
        invalid.add(name);
      }
    }
    if (!invalid.has('AUTH_ISSUER') && !invalid.has('AUTH_JWKS_URL'))
      auth = Object.freeze({ issuer: selectedIssuer!, jwksUrl: selectedJwks! });
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
  if (localDemoEnabled) invalid.add('GATEWAY_DEMO_NO_AUTH_ENABLED');
  const upstreams: Partial<Record<Upstream, string>> = {};
  for (const service of Object.keys(upstreamVariables) as Upstream[]) {
    const variable = upstreamVariables[service],
      value = environment[variable];
    if (value === undefined) continue;
    try {
      if (value.trim() !== value) throw new Error();
      upstreams[service] = internalOrigin(value, false, service);
    } catch {
      invalid.add(variable);
    }
  }
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
    securityMode: securityMode as PromotionsConfiguration['securityMode'],
    publicOperations: Object.freeze(publicOperations),
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
    localDemoEnabled: false,
    listenHost: '::',
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
