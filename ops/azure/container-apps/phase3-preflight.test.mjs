import test from 'node:test';
import assert from 'node:assert/strict';
import { phase3Trust, validatePhase3Runtime } from './phase3-preflight.mjs';
const issuer = 'https://g7.test/api/v1/auth',
  jwksUrl = issuer + '/.well-known/jwks.json';
function fixture() {
  const runtime = {};
  for (const [service, [iss, jwks, discovery]] of Object.entries(phase3Trust))
    runtime[service] = {
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      [iss]: issuer,
      [jwks]: jwksUrl,
      ...(discovery
        ? { [discovery]: issuer + '/.well-known/openid-configuration' }
        : {}),
    };
  for (const [service, prefix] of Object.entries({
    'api-gateway': 'GATEWAY_SERVICE',
    'catalog-svc': 'CATALOG_SERVICE',
    'pricing-svc': 'PRICING_SERVICE',
    'promotions-svc': 'PROMOTIONS_SERVICE',
    'combos-svc': 'COMBOS_G7',
  })) {
    runtime[service][prefix + '_TOKEN_URL'] = issuer + '/token';
    runtime[service][prefix + '_CLIENT_SECRET'] = 'isolated-fixture';
  }
  return runtime;
}
test('all nine services require the same secure real G7 trust and own technical credentials', () => {
  const runtime = fixture();
  assert.equal(Object.keys(runtime).length, 9);
  assert.deepEqual(validatePhase3Runtime(runtime), { issuer, jwksUrl });
});
test('missing trust fails per service without leaking values', () => {
  for (const [service, [iss, jwks, discovery]] of Object.entries(phase3Trust)) {
    for (const key of [iss, jwks, discovery].filter(Boolean)) {
      const runtime = fixture();
      delete runtime[service][key];
      assert.throws(() => validatePhase3Runtime(runtime), /G7_/);
    }
  }
});
test('mixed issuers, phases, simulator URLs and insecure or credentialed URLs fail closed', () => {
  for (const update of [
    (r) => (r['catalog-svc'].SECURITY_ISSUER = 'https://other.test'),
    (r) => (r['inventory-svc'].G6_SECURITY_MODE = 'PUBLIC_READ_ONLY'),
    (r) => (r['bulk-svc'].SIMULATED_AUTH_ISSUER = 'https://simulated.test'),
    (r) => (r['api-gateway'].AUTH_JWKS_URL = 'http://g7.test/jwks'),
    (r) => (r['api-gateway'].AUTH_ISSUER = 'https://private:test@g7.test'),
    (r) =>
      (r['api-gateway'].GATEWAY_SERVICE_TOKEN_URL =
        'https://other.test/api/v1/auth/token'),
  ]) {
    const runtime = fixture();
    update(runtime);
    assert.throws(() => validatePhase3Runtime(runtime), /G7_/);
  }
});
test('technical secrets are required only for configured M2M consumers and never included in errors', () => {
  for (const [service, key] of Object.entries({
    'api-gateway': 'GATEWAY_SERVICE_CLIENT_SECRET',
    'catalog-svc': 'CATALOG_SERVICE_CLIENT_SECRET',
    'pricing-svc': 'PRICING_SERVICE_CLIENT_SECRET',
    'promotions-svc': 'PROMOTIONS_SERVICE_CLIENT_SECRET',
    'combos-svc': 'COMBOS_G7_CLIENT_SECRET',
  })) {
    const runtime = fixture();
    delete runtime[service][key];
    assert.throws(
      () => validatePhase3Runtime(runtime),
      new RegExp('G7_TECHNICAL_CREDENTIAL_REQUIRED_' + service),
    );
  }
});
