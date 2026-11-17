// Preflight only: it does not grant scopes, contact G7 or activate a deployment.
export const phase3Trust = {
  'api-gateway': ['AUTH_ISSUER', 'AUTH_JWKS_URL'],
  'catalog-svc': [
    'SECURITY_ISSUER',
    'SECURITY_JWKS_URL',
    'SECURITY_DISCOVERY_URL',
  ],
  'taxonomy-svc': [
    'SECURITY_ISSUER',
    'SECURITY_JWKS_URL',
    'SECURITY_DISCOVERY_URL',
  ],
  'pricing-svc': ['AUTH_ISSUER', 'AUTH_JWKS_URL'],
  'price-audit-svc': ['AUTH_ISSUER', 'AUTH_JWKS_URL'],
  'promotions-svc': ['AUTH_ISSUER', 'AUTH_JWKS_URL'],
  'inventory-svc': ['G7_JWT_ISSUER', 'G7_JWT_JWKS_URL'],
  'combos-svc': [
    'SECURITY_ISSUER',
    'SECURITY_JWKS_URL',
    'SECURITY_DISCOVERY_URL',
  ],
  'bulk-svc': ['G7_JWT_ISSUER', 'G7_JWT_JWKS_URL'],
};
const technical = {
  'api-gateway': ['GATEWAY_SERVICE_TOKEN_URL', 'GATEWAY_SERVICE_CLIENT_SECRET'],
  'catalog-svc': ['CATALOG_SERVICE_TOKEN_URL', 'CATALOG_SERVICE_CLIENT_SECRET'],
  'pricing-svc': ['PRICING_SERVICE_TOKEN_URL', 'PRICING_SERVICE_CLIENT_SECRET'],
  'promotions-svc': [
    'PROMOTIONS_SERVICE_TOKEN_URL',
    'PROMOTIONS_SERVICE_CLIENT_SECRET',
  ],
  'combos-svc': ['COMBOS_G7_TOKEN_URL', 'COMBOS_G7_CLIENT_SECRET'],
};
function httpsUrl(raw, code) {
  try {
    const value = new URL(raw);
    if (
      typeof raw !== 'string' ||
      raw !== raw.trim() ||
      value.protocol !== 'https:' ||
      value.username ||
      value.password ||
      value.search ||
      value.hash
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(code);
  }
}
export function validatePhase3Runtime(runtime) {
  let commonIssuer, commonJwks;
  for (const [service, [issuerKey, jwksKey, discoveryKey]] of Object.entries(
    phase3Trust,
  )) {
    const env = runtime[service];
    if (!env || env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED')
      throw new Error('G7_MODE_MISMATCH_' + service);
    const issuer = httpsUrl(env[issuerKey], 'G7_ISSUER_REQUIRED_' + service);
    const jwks = httpsUrl(env[jwksKey], 'G7_JWKS_REQUIRED_' + service);
    if (
      (commonIssuer && commonIssuer !== env[issuerKey]) ||
      (commonJwks && commonJwks !== env[jwksKey])
    )
      throw new Error('G7_TRUST_MISMATCH_' + service);
    commonIssuer = env[issuerKey];
    commonJwks = env[jwksKey];
    if (jwks.origin !== issuer.origin)
      throw new Error('G7_JWKS_ORIGIN_MISMATCH_' + service);
    if (discoveryKey) {
      const discovery = httpsUrl(
        env[discoveryKey],
        'G7_DISCOVERY_REQUIRED_' + service,
      );
      if (discovery.origin !== issuer.origin)
        throw new Error('G7_DISCOVERY_ORIGIN_MISMATCH_' + service);
    }
    if (
      Object.entries(env).some(
        ([key, value]) =>
          value &&
          (key.startsWith('SIMULATED_AUTH_') ||
            key.startsWith('COMBOS_SIMULATED_')),
      )
    )
      throw new Error('G7_SIMULATED_TRUST_FORBIDDEN_' + service);
    if (technical[service]) {
      const [urlKey, secretKey] = technical[service];
      const endpoint = httpsUrl(
        env[urlKey],
        'G7_TOKEN_ENDPOINT_REQUIRED_' + service,
      );
      if (
        endpoint.origin !== issuer.origin ||
        endpoint.pathname !== '/api/v1/auth/token' ||
        !env[secretKey]?.trim()
      )
        throw new Error('G7_TECHNICAL_CREDENTIAL_REQUIRED_' + service);
    }
  }
  return { issuer: commonIssuer, jwksUrl: commonJwks };
}
