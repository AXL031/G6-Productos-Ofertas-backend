import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';

export const BULK_ENVIRONMENT = Symbol('BULK_ENVIRONMENT');
export const BULK_READINESS_POOL = Symbol('BULK_READINESS_POOL');

export interface BulkEnvironment {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: '127.0.0.1' | '0.0.0.0';
  readonly port: number;
  readonly databaseUrl?: string;
  readonly databaseSsl: false | Readonly<ConnectionOptions>;
  readonly httpRequestTimeoutMs: 15000;
  readonly httpHeadersTimeoutMs: 10000;
  readonly httpKeepAliveTimeoutMs: 5000;
  readonly httpMaxRequestsPerSocket: 100;
  readonly httpMaxHeadersCount: 100;
  readonly databasePoolMax: 2;
  readonly databaseConnectionTimeoutMs: 1500;
  readonly databaseQueryTimeoutMs: 2000;
  readonly databaseIdleTimeoutMs: 30000;
}

export class InvalidBulkEnvironment extends Error {}

const readCertificate = (path: string): string => readFileSync(path, 'utf8');

function fail(message: string): never {
  throw new InvalidBulkEnvironment(message);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function strictPort(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) fail('Puerto de bulk-svc inválido.');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail('Puerto de bulk-svc inválido.');
  }
  return port;
}

function validateDatabaseUrl(raw: string): URL {
  let url: URL;
  try {
    if (!raw || raw !== raw.trim() || /\s/.test(raw) || raw.includes('#'))
      throw new Error();
    url = new URL(raw);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      url.pathname.length <= 1 ||
      url.pathname.slice(1).includes('/') ||
      url.hash ||
      (url.port &&
        (!/^\d+$/.test(url.port) ||
          Number(url.port) < 1 ||
          Number(url.port) > 65535))
    )
      throw new Error();
  } catch {
    return fail('DATABASE_URL debe ser una URL PostgreSQL válida.');
  }

  for (const key of url.searchParams.keys()) {
    if (
      !['sslmode', 'sslrootcert'].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      fail('DATABASE_URL solo permite parámetros TLS únicos conocidos.');
    }
  }
  return url;
}

/** Parse and validate an explicit environment map without changing process.env. */
export function parseBulkEnvironment(
  env: NodeJS.ProcessEnv,
  certificateReader: (path: string) => string = readCertificate,
): BulkEnvironment {
  const nodeEnv = env.NODE_ENV;
  if (
    nodeEnv !== 'development' &&
    nodeEnv !== 'test' &&
    nodeEnv !== 'production'
  ) {
    fail('NODE_ENV debe ser development, test o production.');
  }

  const port = strictPort(env.BULK_SVC_PORT ?? env.PORT ?? '3008');
  const host =
    env.BULK_SVC_HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    fail('BULK_SVC_HOST debe ser 127.0.0.1 o 0.0.0.0.');
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    fail('La validación TLS global debe permanecer habilitada.');
  }

  let databaseUrl: string | undefined;
  let databaseSsl: false | ConnectionOptions = false;
  if (env.DATABASE_URL !== undefined) {
    const url = validateDatabaseUrl(env.DATABASE_URL);
    const urlMode = url.searchParams.get('sslmode') ?? undefined;
    const envMode = env.PGSSLMODE;
    if (urlMode !== undefined && envMode !== undefined && urlMode !== envMode) {
      fail('La configuración TLS PostgreSQL es conflictiva.');
    }
    const mode = urlMode ?? envMode;
    const local = isLoopback(url.hostname);
    const plaintextAllowed =
      nodeEnv !== 'production' && local && mode === 'disable';
    if (!plaintextAllowed) {
      if (mode !== 'verify-full') {
        fail(
          'PostgreSQL requiere sslmode=verify-full fuera de pruebas locales aisladas.',
        );
      }
      const urlCa = url.searchParams.get('sslrootcert') ?? undefined;
      const envCa = env.PGSSLROOTCERT;
      if (urlCa !== undefined && envCa !== undefined && urlCa !== envCa) {
        fail('La autoridad certificadora PostgreSQL es conflictiva.');
      }
      const caPath = urlCa ?? envCa;
      if (nodeEnv === 'production' && !local && !caPath) {
        fail('PostgreSQL remoto en production requiere una CA explícita.');
      }
      let ca: string | undefined;
      if (caPath !== undefined) {
        try {
          if (!isAbsolute(caPath)) throw new Error();
          ca = certificateReader(caPath);
          if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error();
          if (!new X509Certificate(ca).ca) throw new Error();
        } catch {
          fail(
            'PGSSLROOTCERT/sslrootcert debe identificar una CA legible y válida.',
          );
        }
      }
      databaseSsl = Object.freeze({
        rejectUnauthorized: true,
        checkServerIdentity,
        ...(ca ? { ca } : {}),
      });
    } else if (
      url.searchParams.has('sslrootcert') ||
      env.PGSSLROOTCERT !== undefined
    ) {
      fail(
        'No se permite configurar una CA cuando PostgreSQL loopback usa texto plano.',
      );
    }
    // pg parses libpq URL parameters and can override `ssl`; remove the TLS
    // parameters after validating them so the checked options remain effective.
    url.search = '';
    databaseUrl = url.toString();
  }

  return Object.freeze({
    nodeEnv,
    host,
    port,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    databaseSsl,
    httpRequestTimeoutMs: 15000,
    httpHeadersTimeoutMs: 10000,
    httpKeepAliveTimeoutMs: 5000,
    httpMaxRequestsPerSocket: 100,
    httpMaxHeadersCount: 100,
    databasePoolMax: 2,
    databaseConnectionTimeoutMs: 1500,
    databaseQueryTimeoutMs: 2000,
    databaseIdleTimeoutMs: 30000,
  });
}
