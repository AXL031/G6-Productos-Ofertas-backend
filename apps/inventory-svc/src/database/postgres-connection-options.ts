import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { PoolConfig } from 'pg';
import type { InventoryConfig } from '../config/inventory.config.js';

type TlsMode = 'disable' | 'verified';

const SSL_URL_PARAMETERS = [
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslpassword',
  'sslnegotiation',
] as const;

function normalizedTlsMode(value: string | undefined): TlsMode | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'disable') return 'disable';
  if (value === 'verify-full' || value === 'require') return 'verified';
  throw new Error('PGSSLMODE debe ser disable, require o verify-full.');
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    (isIP(normalized) === 4 && normalized.startsWith('127.')) ||
    normalized === '::1'
  );
}

function safeUrlSettings(databaseUrl: string): {
  url: URL;
  urlTlsMode?: TlsMode;
} {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL no es una URL PostgreSQL válida.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL debe usar el esquema postgres o postgresql.');
  }
  if (!url.hostname)
    throw new Error('DATABASE_URL requiere un host PostgreSQL.');
  if (
    SSL_URL_PARAMETERS.some(
      (parameter) => url.searchParams.getAll(parameter).length > 1,
    )
  ) {
    throw new Error('DATABASE_URL contiene parámetros SSL duplicados.');
  }

  const urlModeValue = url.searchParams.get('sslmode') ?? undefined;
  const urlTlsMode = normalizedTlsMode(urlModeValue);
  for (const parameter of SSL_URL_PARAMETERS.slice(1)) {
    if (url.searchParams.has(parameter)) {
      throw new Error(
        `DATABASE_URL no debe incluir ${parameter}; use la configuración PG SSL explícita.`,
      );
    }
  }
  for (const parameter of SSL_URL_PARAMETERS) {
    url.searchParams.delete(parameter);
  }
  return { url, urlTlsMode };
}

export function createPostgresPoolOptions(
  config: InventoryConfig,
  environment: NodeJS.ProcessEnv = process.env,
): PoolConfig | null {
  const production = environment.NODE_ENV === 'production';
  const hasUrl = Boolean(config.databaseUrl?.trim());
  const hasFieldConfig = Boolean(
    config.pgHost || config.pgDatabase || config.pgUser || config.pgPassword,
  );
  if (!hasUrl && !hasFieldConfig) {
    if (production) {
      throw new Error('Falta la configuración PostgreSQL obligatoria.');
    }
    return null;
  }
  if (hasUrl && hasFieldConfig) {
    throw new Error('Configure DATABASE_URL o credenciales PG, no ambos.');
  }

  let host: string;
  let connectionString: string | undefined;
  let base: PoolConfig;
  let urlTlsMode: TlsMode | undefined;
  if (hasUrl) {
    const parsed = safeUrlSettings(config.databaseUrl!);
    if (production && (!parsed.url.username || !parsed.url.password)) {
      throw new Error(
        'DATABASE_URL requiere credenciales PostgreSQL en producción.',
      );
    }
    host = parsed.url.hostname;
    urlTlsMode = parsed.urlTlsMode;
    connectionString = parsed.url.toString();
    base = { connectionString };
  } else {
    if (
      !config.pgHost ||
      !config.pgDatabase ||
      !config.pgUser ||
      !config.pgPassword
    ) {
      throw new Error(
        'La configuración PostgreSQL por campos está incompleta.',
      );
    }
    host = config.pgHost;
    base = {
      host,
      port: config.pgPort ?? 5432,
      database: config.pgDatabase,
      user: config.pgUser,
      password: config.pgPassword,
    };
  }

  const environmentTlsMode = normalizedTlsMode(config.pgSslMode);
  if (
    environmentTlsMode !== undefined &&
    urlTlsMode !== undefined &&
    environmentTlsMode !== urlTlsMode
  ) {
    throw new Error(
      'DATABASE_URL y PGSSLMODE contienen modos TLS conflictivos.',
    );
  }
  const requestedMode = environmentTlsMode ?? urlTlsMode;
  const loopback = isLoopback(host);
  const mode =
    requestedMode ?? (loopback && !production ? 'disable' : 'verified');
  if (mode === 'disable' && (!loopback || production)) {
    throw new Error(
      'TLS deshabilitado solo se permite en PostgreSQL local no productivo.',
    );
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0' && mode === 'verified') {
    throw new Error(
      'La validación TLS de Node.js no puede estar deshabilitada.',
    );
  }

  if (mode === 'disable') {
    if (config.pgSslRootCert) {
      throw new Error(
        'PGSSLROOTCERT no puede combinarse con TLS deshabilitado.',
      );
    }
    return {
      ...base,
      options: '-c search_path=inventory,public',
      ssl: false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      lock_timeout: 5000,
      query_timeout: 20000,
    };
  }

  let ca: string | undefined;
  if (config.pgSslRootCert) {
    if (!existsSync(config.pgSslRootCert)) {
      throw new Error('La CA configurada en PGSSLROOTCERT no está disponible.');
    }
    try {
      ca = readFileSync(config.pgSslRootCert, 'utf8');
      if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
        throw new Error('invalid CA');
      }
    } catch {
      throw new Error(
        'La CA configurada en PGSSLROOTCERT no es legible o válida.',
      );
    }
  }

  return {
    ...base,
    options: '-c search_path=inventory,public',
    ssl: { ...(ca ? { ca } : {}), rejectUnauthorized: true },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    lock_timeout: 5000,
    query_timeout: 20000,
  };
}
