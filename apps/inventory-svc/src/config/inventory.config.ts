import { trustedJwksUrl } from '../auth/trusted-jwks.js';
import { PHASE1_PUBLIC_OPERATION_IDS } from '../phase1-public-reads.js';
import { isIP } from 'node:net';

export interface InventoryConfig {
  securityMode: 'PUBLIC_READ_ONLY' | 'SIMULATED_AUTH' | 'G7_AUTHENTICATED';
  publicOperations: readonly string[];
  databaseUrl?: string;
  pgHost?: string;
  pgPort?: number;
  pgDatabase?: string;
  pgUser?: string;
  pgPassword?: string;
  pgSslMode?: string;
  pgSslRootCert?: string;
  catalogSkuDeactivationEnabled: boolean;
  rabbitMqUrl?: string;
  port: number;
  reservationTtlSeconds: number;
  defaultLowStockThreshold: number;
  workerIntervalMs: number;
  workerBatchSize: number;
  commercialDemo: CommercialDemoConfig;
}

export interface CommercialDemoConfig {
  enabled: boolean;
  gatewayIps: readonly string[];
}

/** Normaliza IPv4, IPv6 y direcciones IPv4 mapeadas sin confiar en headers de proxy. */
export function canonicalPeerIp(value: string | undefined): string | null {
  if (!value || value.includes('%') || !isIP(value)) return null;
  const address = isIP(value) === 4 ? `::ffff:${value}` : value;
  return new URL(`http://[${address}]/`).hostname;
}

export function loadCommercialDemoConfig(): CommercialDemoConfig {
  const flag = process.env.INVENTORY_DEMO_NO_AUTH_ENABLED ?? 'false';
  if (flag !== 'true' && flag !== 'false') {
    throw new Error(
      '[inventory-svc] INVENTORY_DEMO_NO_AUTH_ENABLED debe ser true o false',
    );
  }
  const rawIps = process.env.INVENTORY_DEMO_GATEWAY_IPS;
  const gatewayIps =
    rawIps === undefined
      ? []
      : rawIps.split(',').map((ip) => canonicalPeerIp(ip.trim()));
  if (
    gatewayIps.some((ip) => ip === null) ||
    (flag === 'true' && gatewayIps.length === 0)
  ) {
    throw new Error(
      '[inventory-svc] INVENTORY_DEMO_GATEWAY_IPS requiere IPs literales exactas del Gateway',
    );
  }
  return { enabled: flag === 'true', gatewayIps: gatewayIps as string[] };
}

function integerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw.trim()) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    // No registrar el valor recibido: puede contener material confidencial.
    const label =
      name === 'INVENTORY_SVC_PORT' || name === 'PORT'
        ? `Puerto inválido (${name})`
        : `${name} inválido`;
    throw new Error(
      `[inventory-svc] ${label}. Debe ser un entero decimal entre ${minimum} y ${maximum}.`,
    );
  }
  return value;
}

export function loadInventoryConfig(): InventoryConfig {
  const securityMode = process.env.G6_SECURITY_MODE ?? 'G7_AUTHENTICATED';
  if (
    !['PUBLIC_READ_ONLY', 'SIMULATED_AUTH', 'G7_AUTHENTICATED'].includes(
      securityMode,
    )
  )
    throw new Error('[inventory-svc] G6_SECURITY_MODE inválido');
  const publicOperations = (process.env.INVENTORY_PUBLIC_OPERATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    publicOperations.some((id) => !PHASE1_PUBLIC_OPERATION_IDS.has(id)) ||
    (securityMode !== 'PUBLIC_READ_ONLY' && publicOperations.length)
  )
    throw new Error('[inventory-svc] INVENTORY_PUBLIC_OPERATION_IDS inválido');
  if (securityMode === 'SIMULATED_AUTH') {
    try {
      const issuer = new URL(process.env.SIMULATED_AUTH_ISSUER ?? '');
      const jwks = new URL(process.env.SIMULATED_AUTH_JWKS_URL ?? '');
      const local = (url: URL) =>
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      const testHttp = process.env.NODE_ENV === 'test';
      if (
        issuer.href ===
          new URL(process.env.G7_JWT_ISSUER ?? 'https://invalid').href ||
        (issuer.protocol !== 'https:' &&
          !(testHttp && issuer.protocol === 'http:' && local(issuer))) ||
        (jwks.protocol !== 'https:' &&
          !(testHttp && jwks.protocol === 'http:' && local(jwks))) ||
        issuer.username ||
        issuer.password ||
        issuer.hash ||
        jwks.username ||
        jwks.password ||
        jwks.hash
      )
        throw new Error();
    } catch {
      throw new Error(
        '[inventory-svc] SIMULATED_AUTH requiere issuer y JWKS seguros e independientes de G7',
      );
    }
  }
  if (process.env.G7_JWT_JWKS_URL !== undefined) {
    trustedJwksUrl(process.env.G7_JWT_JWKS_URL, process.env.NODE_ENV);
    trustedJwksUrl(process.env.G7_JWT_ISSUER, process.env.NODE_ENV);
  }
  const portName =
    process.env.INVENTORY_SVC_PORT === undefined
      ? 'PORT'
      : 'INVENTORY_SVC_PORT';
  const port = integerSetting(portName, 3005, 1, 65535);
  const reservationTtlSeconds = integerSetting(
    'RESERVATION_TTL_SECONDS',
    900,
    1,
  );
  const defaultLowStockThreshold = integerSetting(
    'DEFAULT_LOW_STOCK_THRESHOLD',
    5,
    0,
  );
  // Node convierte intervalos mayores al máximo de int32 en un intervalo de 1 ms.
  const workerIntervalMs = integerSetting(
    'INVENTORY_WORKER_INTERVAL_MS',
    5000,
    250,
    2147483647,
  );
  const workerBatchSize = integerSetting(
    'INVENTORY_WORKER_BATCH_SIZE',
    50,
    1,
    500,
  );
  const pgPort = integerSetting('PGPORT', 5432, 1, 65535);
  const skuDeactivationGate =
    process.env.INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED ?? 'false';
  if (skuDeactivationGate !== 'true' && skuDeactivationGate !== 'false') {
    throw new Error(
      '[inventory-svc] INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED debe ser true o false',
    );
  }

  return {
    securityMode: securityMode as InventoryConfig['securityMode'],
    publicOperations: Object.freeze(publicOperations),
    databaseUrl: process.env.DATABASE_URL,
    pgHost: process.env.PGHOST,
    pgPort,
    pgDatabase: process.env.PGDATABASE,
    pgUser: process.env.PGUSER,
    pgPassword: process.env.PGPASSWORD,
    pgSslMode: process.env.PGSSLMODE,
    pgSslRootCert: process.env.PGSSLROOTCERT,
    catalogSkuDeactivationEnabled: skuDeactivationGate === 'true',
    rabbitMqUrl: process.env.RABBITMQ_URL,
    port,
    reservationTtlSeconds,
    defaultLowStockThreshold,
    workerIntervalMs,
    workerBatchSize,
    commercialDemo: loadCommercialDemoConfig(),
  };
}
