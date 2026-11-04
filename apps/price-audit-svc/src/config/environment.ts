import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';

export const PRICE_AUDIT_CONFIG = Symbol('PRICE_AUDIT_CONFIG');

export interface AuditConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  hotRetentionMonths: number;
  archiveRetentionYears: number;
  amqpUrl?: string;
  exportDirectory?: string;
  exportFont?: string;
  databaseUrl: string;
  databaseSsl: false | ConnectionOptions;
  auth?: { issuer: string; jwksUrl: string };
}

export class InvalidAuditConfig extends Error {}

export function validateEnvironment(env: NodeJS.ProcessEnv): AuditConfig {
  const nodeEnv = env.NODE_ENV;
  if (
    nodeEnv !== 'development' &&
    nodeEnv !== 'test' &&
    nodeEnv !== 'production'
  ) {
    throw new InvalidAuditConfig(
      'NODE_ENV debe ser development, test o production.',
    );
  }
  const rawPort = env.PRICE_AUDIT_SVC_PORT ?? env.PORT;
  const port = Number(rawPort);
  if (
    !rawPort ||
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new InvalidAuditConfig(
      'PRICE_AUDIT_SVC_PORT (o PORT) debe ser un entero entre 1 y 65535.',
    );
  }
  const databaseUrl = env.DATABASE_URL;
  let url: URL;
  try {
    if (
      !databaseUrl ||
      databaseUrl !== databaseUrl.trim() ||
      /\s/.test(databaseUrl)
    )
      throw new Error();
    url = new URL(databaseUrl);
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
    throw new InvalidAuditConfig(
      'DATABASE_URL debe incluir host, usuario y base PostgreSQL válidos.',
    );
  }
  // No dejar que el parser de pg reemplace ssl o el host validado desde la URL.
  for (const key of url.searchParams.keys()) {
    if (
      !['sslmode', 'sslrootcert'].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      throw new InvalidAuditConfig(
        'DATABASE_URL solo permite parámetros sslmode y sslrootcert únicos.',
      );
    }
  }
  if (
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new InvalidAuditConfig(
      'La validación TLS global debe permanecer habilitada.',
    );
  }
  const mode = url.searchParams.get('sslmode') ?? env.PGSSLMODE;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(
    url.hostname.toLowerCase(),
  );
  const allowPlaintext =
    nodeEnv !== 'production' &&
    local &&
    (mode === undefined || mode === 'disable');
  let databaseSsl: AuditConfig['databaseSsl'] = false;
  if (!allowPlaintext) {
    if (mode !== 'verify-full') {
      throw new InvalidAuditConfig(
        'DATABASE_URL requiere sslmode=verify-full fuera de pruebas locales aisladas.',
      );
    }
    databaseSsl = { rejectUnauthorized: true, checkServerIdentity };
    const caPath = url.searchParams.get('sslrootcert') ?? env.PGSSLROOTCERT;
    if (caPath !== undefined) {
      try {
        const ca = readFileSync(caPath, 'utf8');
        new X509Certificate(ca);
        databaseSsl.ca = ca;
      } catch {
        throw new InvalidAuditConfig(
          'PGSSLROOTCERT/sslrootcert debe contener una CA legible.',
        );
      }
    }
  }
  url.search = '';
  let auth: AuditConfig['auth'];
  {
    try {
      for (const value of [env.AUTH_ISSUER, env.AUTH_JWKS_URL]) {
        if (!value || value !== value.trim()) throw new Error();
        const endpoint = new URL(value);
        if (
          endpoint.username ||
          endpoint.password ||
          endpoint.hash ||
          (endpoint.protocol !== 'https:' &&
            !(
              nodeEnv === 'test' &&
              endpoint.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
            ))
        )
          throw new Error();
      }
      auth = { issuer: env.AUTH_ISSUER!, jwksUrl: env.AUTH_JWKS_URL! };
    } catch {
      throw new InvalidAuditConfig(
        'AUTH_ISSUER y AUTH_JWKS_URL deben ser URLs seguras válidas.',
      );
    }
  }
  const hotRetentionMonths = Number(env.AUDIT_HOT_RETENTION_MONTHS ?? '24');
  for (const key of ['AUDIT_EXPORT_DIRECTORY', 'AUDIT_EXPORT_FONT']) {
    const value = env[key];
    if (
      value !== undefined &&
      (!value || value !== value.trim() || !isAbsolute(value))
    )
      throw new InvalidAuditConfig(`${key} debe ser una ruta absoluta.`);
  }
  const archiveRetentionYears = Number(
    env.AUDIT_ARCHIVE_RETENTION_YEARS ?? '5',
  );
  if (
    ![
      env.AUDIT_HOT_RETENTION_MONTHS ?? '24',
      env.AUDIT_ARCHIVE_RETENTION_YEARS ?? '5',
    ].every((value) => /^[1-9]\d*$/.test(value)) ||
    !Number.isSafeInteger(hotRetentionMonths) ||
    !Number.isSafeInteger(archiveRetentionYears)
  )
    throw new InvalidAuditConfig(
      'La retención debe expresarse con enteros positivos.',
    );
  return {
    ...(env.AUDIT_EXPORT_DIRECTORY
      ? { exportDirectory: env.AUDIT_EXPORT_DIRECTORY }
      : {}),
    ...(env.AUDIT_EXPORT_FONT ? { exportFont: env.AUDIT_EXPORT_FONT } : {}),
    ...(env.PRICE_AUDIT_AMQP_URL === undefined
      ? {}
      : { amqpUrl: validateAmqpUrl(env.PRICE_AUDIT_AMQP_URL, nodeEnv) }),
    hotRetentionMonths,
    archiveRetentionYears,
    nodeEnv,
    port,
    databaseUrl: url.toString(),
    databaseSsl,
    ...(auth ? { auth } : {}),
  };
}

export function validateAmqpUrl(value: string, environment: string): string {
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      url.hash ||
      url.search ||
      !url.username ||
      !url.password ||
      !['amqp:', 'amqps:'].includes(url.protocol) ||
      (url.protocol !== 'amqps:' &&
        (environment === 'production' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    )
      throw new Error();
    url.searchParams.set('heartbeat', '5');
    return url.toString();
  } catch {
    throw new InvalidAuditConfig(
      'PRICE_AUDIT_AMQP_URL debe ser AMQPS; AMQP solo en loopback de pruebas.',
    );
  }
}
