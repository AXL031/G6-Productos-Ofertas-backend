import test from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { readFileSync } from 'node:fs';
import { phase3Trust } from './phase3-preflight.mjs';
import {
  makeDeployment,
  parseRelease,
  services,
} from './render-deployment.mjs';

const operations = JSON.parse(
  readFileSync(new URL('./phase1-operations.json', import.meta.url)),
).operations.filter((row) => row.phase1Selected);
const sha = 'a'.repeat(40),
  digest = 'sha256:' + 'b'.repeat(64);
const psv = services.map((s) => `${s}|${sha}|${digest}`).join('\n');
const prefixes = [
  'GATEWAY',
  'CATALOG',
  'TAXONOMY',
  'PRICING',
  'PRICE_AUDIT',
  'PROMOTIONS',
  'INVENTORY',
  'COMBOS',
  'BULK',
];
function fixture() {
  return {
    release: parseRelease(psv),
    registryUser: 'test-reader',
    registryPassword: 'test-registry-password',
    ca: rootCertificates[0],
    caddyImage: 'caddy:2.11.6-alpine@' + digest,
    enablePublicReads: true,
    runtime: Object.fromEntries(
      services.map((s, i) => [
        s,
        {
          NODE_ENV: 'production',
          G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
          [i === 7
            ? 'COMBOS_PUBLIC_READ_OPERATIONS'
            : prefixes[i] + '_PUBLIC_OPERATION_IDS']: operations
            .filter((r) => i === 0 || r.service === s)
            .map((r) => r.operationId)
            .join(','),
          ...(i
            ? {
                PGSSLMODE: 'verify-full',
                PGSSLROOTCERT: '/run/g6-certs/supabase-server-root.crt',
                PGPASSWORD: 'test-db-password',
              }
            : {}),
        },
      ]),
    ),
  };
}
test('release rejects missing, duplicate, unknown services and mixed revisions', () => {
  assert.throws(
    () => parseRelease(psv.split('\n').slice(1).join('\n')),
    /NINE/,
  );
  assert.throws(
    () => parseRelease(psv.replace('catalog-svc', 'api-gateway')),
    /INVALID/,
  );
  assert.throws(
    () => parseRelease(psv.replace('catalog-svc', 'unknown-svc')),
    /INVALID/,
  );
  assert.throws(() => parseRelease(psv.replace(sha, 'c'.repeat(40))), /MIXED/);
  assert.throws(() => parseRelease(psv.replace(digest, 'PENDING')), /INVALID/);
});
test('public exposure requires explicit selection with exact operation sets', () => {
  const input = fixture();
  input.enablePublicReads = false;
  assert.throws(() => makeDeployment(input), /EXPLICIT/);
  input.enablePublicReads = true;
  input.runtime['catalog-svc'].CATALOG_PUBLIC_OPERATION_IDS += ',writeAnything';
  assert.throws(() => makeDeployment(input), /EXACT_PUBLIC_SCOPE/);
});
test('simulator, legacy bypass and invalid PostgreSQL trust are rejected', () => {
  const input = fixture();
  input.runtime['api-gateway'].G6_SECURITY_MODE = 'SIMULATED_AUTH';
  assert.throws(() => makeDeployment(input), /CLOUD_MODE/);
  input.runtime['api-gateway'].G6_SECURITY_MODE = 'PUBLIC_READ_ONLY';
  input.runtime['api-gateway'].GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
  assert.throws(() => makeDeployment(input), /BYPASS/);
  delete input.runtime['api-gateway'].GATEWAY_DEMO_NO_AUTH_ENABLED;
  input.runtime['catalog-svc'].PGSSLMODE = 'require';
  assert.throws(() => makeDeployment(input), /POSTGRES_TLS/);
});
test('ARM contains no private credentials and isolates eight internal HTTPS apps', () => {
  const plan = makeDeployment(fixture()),
    apps = plan.template.resources.slice(1),
    text = JSON.stringify(plan.template);
  assert.equal(
    plan.template.resources[0].properties.environmentMode,
    'WorkloadProfiles',
  );
  assert.equal(apps.length, 9);
  assert.equal(
    apps.filter((a) => a.properties.configuration.ingress.external).length,
    1,
  );
  assert.equal(apps[0].name, 'api-gateway');
  assert.equal(apps[0].properties.configuration.ingress.targetPort, 8080);
  assert.ok(
    !text.includes('test-db-password') &&
      !text.includes('test-registry-password'),
  );
  assert.equal(plan.template.parameters.runtime.type, 'secureObject');
  for (const app of apps) {
    assert.equal(app.properties.configuration.ingress.allowInsecure, false);
    assert.deepEqual(
      [
        app.properties.template.scale.minReplicas,
        app.properties.template.scale.maxReplicas,
      ],
      [0, 1],
    );
    assert.ok(app.properties.template.containers[0].image.includes('@sha256:'));
  }
  for (const app of apps.slice(1))
    assert.equal(app.properties.template.volumes[0].storageType, 'Secret');
  const catalogUrl = apps[0].properties.configuration.secrets.find(
    (s) => s.name === 'e-gateway-catalog-svc-url',
  ).value;
  assert.match(catalogUrl, /https:\/\/catalog-svc\.internal\./);
  const catalogApp = apps.find((a) => a.name === 'catalog-svc');
  const catalogPricingUrl = catalogApp.properties.configuration.secrets.find(
    (s) => s.name === 'e-catalog-pricing-url',
  ).value;
  assert.match(catalogPricingUrl, /https:\/\/pricing-svc\.internal\./);
  assert.deepEqual(
    catalogApp.properties.template.containers[0].env.find(
      (e) => e.name === 'CATALOG_PRICING_URL',
    ),
    { name: 'CATALOG_PRICING_URL', secretRef: 'e-catalog-pricing-url' },
  );
  assert.equal(
    plan.parameters.parameters.runtime.value['api-gateway'].GATEWAY_TIMEOUT_MS,
    '30000',
  );
});
test('G7 mode cannot retain any anonymous selectors', () => {
  const input = fixture();
  for (const env of Object.values(input.runtime))
    env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
  assert.throws(() => makeDeployment(input), /EXACT_PUBLIC_SCOPE/);
});

test('G7 deployment renders with nine aligned trust configurations and no anonymous exceptions', () => {
  const input = fixture(),
    issuer = 'https://g7.contract.test/api/v1/auth';
  input.enablePublicReads = false;
  for (const [service, [iss, jwks, discovery]] of Object.entries(phase3Trust)) {
    const env = input.runtime[service];
    env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    for (const key of Object.keys(env))
      if (
        key.endsWith('_PUBLIC_OPERATION_IDS') ||
        key === 'COMBOS_PUBLIC_READ_OPERATIONS'
      )
        delete env[key];
    env[iss] = issuer;
    env[jwks] = issuer + '/.well-known/jwks.json';
    if (discovery)
      env[discovery] = issuer + '/.well-known/openid-configuration';
  }
  for (const [service, prefix] of Object.entries({
    'api-gateway': 'GATEWAY_SERVICE',
    'catalog-svc': 'CATALOG_SERVICE',
    'pricing-svc': 'PRICING_SERVICE',
    'promotions-svc': 'PROMOTIONS_SERVICE',
    'combos-svc': 'COMBOS_G7',
  })) {
    input.runtime[service][prefix + '_TOKEN_URL'] = issuer + '/token';
    input.runtime[service][prefix + '_CLIENT_SECRET'] = 'isolated-g7-secret';
  }
  const plan = makeDeployment(input);
  assert.equal(plan.template.resources.slice(1).length, 9);
  const g7CatalogApp = plan.template.resources
    .slice(1)
    .find((a) => a.name === 'catalog-svc');
  assert.match(
    g7CatalogApp.properties.configuration.secrets.find(
      (s) => s.name === 'e-catalog-pricing-url',
    ).value,
    /https:\/\/pricing-svc\.internal\./,
  );
  assert.ok(!JSON.stringify(plan.template).includes('isolated-g7-secret'));
  const deployedRuntime = plan.parameters.parameters.runtime.value;
  for (const env of Object.values(deployedRuntime)) {
    assert.equal(env.G6_SECURITY_MODE, 'G7_AUTHENTICATED');
    assert.ok(
      !Object.entries(env).some(
        ([key, value]) =>
          (key.endsWith('_PUBLIC_OPERATION_IDS') ||
            key === 'COMBOS_PUBLIC_READ_OPERATIONS') &&
          value,
      ),
    );
  }
  input.runtime['catalog-svc'].SECURITY_ISSUER = 'https://other.contract.test';
  assert.throws(() => makeDeployment(input), /G7_TRUST_MISMATCH/);
});
