import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';

export const PRICING_CONFIG = Symbol('PRICING_CONFIG');

export interface PricingConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  databaseSsl: false | ConnectionOptions;
  auth?: { issuer: string; jwksUrl: string };
  demoNoAuthEnabled?: boolean;
  amqpUrl?: string;
  priceChangedPublishingEnabled?: boolean;
  catalogUrl?: string;
  serviceToken?: { url: string; secret: string };
}

export class InvalidPricingConfig extends Error {}

export function validateEnvironment(env: NodeJS.ProcessEnv): PricingConfig {
  const nodeEnv = env.NODE_ENV;
  if (
    nodeEnv !== 'development' &&
    nodeEnv !== 'test' &&
    nodeEnv !== 'production'
  ) {
    throw new InvalidPricingConfig(
      'NODE_ENV debe ser development, test o production.',
    );
  }
  const demoFlag = env.GATEWAY_DEMO_NO_AUTH_ENABLED ?? 'false';
  const productionConfirmed = env.PRICING_DEMO_PRODUCTION_CONFIRMED ?? 'false';
  if (
    !['true', 'false'].includes(demoFlag) ||
    !['true', 'false'].includes(productionConfirmed)
  ) {
    throw new InvalidPricingConfig(
      'GATEWAY_DEMO_NO_AUTH_ENABLED y PRICING_DEMO_PRODUCTION_CONFIRMED deben ser true/false.',
    );
  }
  if (
    demoFlag === 'true' &&
    nodeEnv === 'production' &&
    productionConfirmed !== 'true'
  ) {
    throw new InvalidPricingConfig(
      'Demo en production requiere PRICING_DEMO_PRODUCTION_CONFIRMED=true.',
    );
  }
  const demoNoAuthEnabled = demoFlag === 'true';
  const priceChangedFlag = env.PRICING_PRICE_CHANGED_PUBLISH_ENABLED ?? 'false';
  if (!['true', 'false'].includes(priceChangedFlag))
    throw new InvalidPricingConfig(
      'PRICING_PRICE_CHANGED_PUBLISH_ENABLED debe ser true o false.',
    );
  const rawPort = env.PRICING_SVC_PORT ?? env.PORT;
  const port = Number(rawPort);
  if (
    !rawPort ||
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new InvalidPricingConfig(
      'PRICING_SVC_PORT (o PORT) debe ser un entero entre 1 y 65535.',
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
    throw new InvalidPricingConfig(
      'DATABASE_URL debe incluir host, usuario y base PostgreSQL válidos.',
    );
  }
  // No dejar que el parser de pg reemplace ssl o el host validado desde la URL.
  for (const key of url.searchParams.keys()) {
    if (
      !['sslmode', 'sslrootcert'].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      throw new InvalidPricingConfig(
        'DATABASE_URL solo permite parámetros sslmode y sslrootcert únicos.',
      );
    }
  }
  if (
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new InvalidPricingConfig(
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
  let databaseSsl: PricingConfig['databaseSsl'] = false;
  if (!allowPlaintext) {
    if (mode !== 'verify-full') {
      throw new InvalidPricingConfig(
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
        throw new InvalidPricingConfig(
          'PGSSLROOTCERT/sslrootcert debe contener una CA legible.',
        );
      }
    }
  }
  url.search = '';
  let auth: PricingConfig['auth'];
  if (
    !demoNoAuthEnabled &&
    (env.AUTH_ISSUER !== undefined || env.AUTH_JWKS_URL !== undefined)
  ) {
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
      throw new InvalidPricingConfig(
        'AUTH_ISSUER y AUTH_JWKS_URL deben ser URLs seguras válidas.',
      );
    }
  }
  let serviceToken: PricingConfig['serviceToken'];
  if (
    env.PRICING_SERVICE_TOKEN_URL !== undefined ||
    env.PRICING_SERVICE_CLIENT_SECRET !== undefined
  ) {
    try {
      const endpoint = new URL(env.PRICING_SERVICE_TOKEN_URL!);
      const issuer = new URL(env.AUTH_ISSUER!);
      const testLoopback =
        nodeEnv === 'test' &&
        endpoint.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
      if (
        !env.PRICING_SERVICE_CLIENT_SECRET?.trim() ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search ||
        endpoint.pathname !== '/api/v1/auth/token' ||
        endpoint.origin !== issuer.origin ||
        (endpoint.protocol !== 'https:' && !testLoopback) ||
        (!demoNoAuthEnabled && !auth)
      )
        throw new Error();
      serviceToken = {
        url: endpoint.toString(),
        secret: env.PRICING_SERVICE_CLIENT_SECRET!,
      };
    } catch {
      throw new InvalidPricingConfig(
        'Credenciales G7 requieren secreto, issuer/JWKS y endpoint seguro /api/v1/auth/token del issuer.',
      );
    }
  }
  let catalogUrl: string | undefined;
  if (env.PRICING_CATALOG_URL !== undefined) {
    try {
      const endpoint = new URL(env.PRICING_CATALOG_URL);
      const privateHttp =
        endpoint.protocol === 'http:' &&
        ((demoNoAuthEnabled && endpoint.hostname === 'catalog-svc') ||
          (nodeEnv === 'test' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)));
      if (
        env.PRICING_CATALOG_URL !== env.PRICING_CATALOG_URL.trim() ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== '/' ||
        (endpoint.protocol !== 'https:' && !privateHttp)
      )
        throw new Error();
      catalogUrl = endpoint.origin;
    } catch {
      throw new InvalidPricingConfig(
        'PRICING_CATALOG_URL requiere origen HTTPS; HTTP solo en Catalog privado demo o loopback test.',
      );
    }
  }
  const amqpUrl =
    env.PRICING_AMQP_URL === undefined
      ? undefined
      : validateAmqpUrl(env.PRICING_AMQP_URL, nodeEnv);
  const priceChangedPublishingEnabled = priceChangedFlag === 'true';
  if (priceChangedPublishingEnabled && !amqpUrl)
    throw new InvalidPricingConfig(
      'La publicación de cambios de precio requiere PRICING_AMQP_URL.',
    );
  return {
    nodeEnv,
    port,
    databaseUrl: url.toString(),
    databaseSsl,
    ...(amqpUrl ? { amqpUrl } : {}),
    ...(priceChangedPublishingEnabled
      ? { priceChangedPublishingEnabled: true }
      : {}),
    ...(catalogUrl ? { catalogUrl } : {}),
    ...(serviceToken ? { serviceToken } : {}),
    ...(auth ? { auth } : {}),
    ...(demoNoAuthEnabled ? { demoNoAuthEnabled: true } : {}),
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
    throw new InvalidPricingConfig(
      'PRICING_AMQP_URL debe ser AMQPS; AMQP solo en loopback de pruebas.',
    );
  }
}
