import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAcaPilot } from './aca-pilot.mjs';

function fixture() {
  const namespace = 'g6-pilot-test.servicebus.windows.net';
  const runtime = {},
    identities = {};
  for (const [index, name] of ['pricing-svc', 'price-audit-svc'].entries()) {
    const clientId = `11111111-1111-4111-8111-11111111111${index}`;
    identities[name] = {
      clientId,
      resourceId: `/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/rg-pilot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`,
    };
    runtime[name] = {
      NODE_ENV: 'production',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      G6_SERVICE_BUS_PILOT_ENABLED: 'true',
      G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
      AZURE_CLIENT_ID: clientId,
      SERVICE_BUS_NAMESPACE_FQDN: namespace,
      ...(index === 0 ? { PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'true' } : {}),
    };
  }
  return { runtime, pilot: { namespace, identities } };
}
test('leaves existing non-pilot deployments unchanged', () => {
  assert.equal(validateAcaPilot({ 'pricing-svc': {} }), undefined);
});
test('returns one exclusive assigned identity per workload', () => {
  const { runtime, pilot } = fixture(),
    result = validateAcaPilot(runtime, pilot);
  for (const name of Object.keys(runtime))
    assert.deepEqual(result[name], {
      type: 'UserAssigned',
      userAssignedIdentities: { [pilot.identities[name].resourceId]: {} },
    });
});
for (const [name, mutate] of Object.entries({
  'missing plan': (f) => {
    delete f.pilot;
  },
  'only one workload': (f) => {
    delete f.runtime['price-audit-svc'];
  },
  'foreign service': (f) => {
    f.runtime['catalog-svc'] = { MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS' };
  },
  'shared identity': (f) => {
    f.pilot.identities['price-audit-svc'] = f.pilot.identities['pricing-svc'];
    f.runtime['price-audit-svc'].AZURE_CLIENT_ID =
      f.runtime['pricing-svc'].AZURE_CLIENT_ID;
  },
  'mixed broker': (f) => {
    f.runtime['pricing-svc'].PRICING_AMQP_URL = '';
  },
  'missing production flag': (f) => {
    delete f.runtime['pricing-svc'].G6_SERVICE_BUS_PRODUCTION_ENABLED;
  },
  'unassigned identity': (f) => {
    f.runtime['pricing-svc'].AZURE_CLIENT_ID =
      '33333333-3333-4333-8333-333333333333';
  },
  'namespace mismatch': (f) => {
    f.runtime['pricing-svc'].SERVICE_BUS_NAMESPACE_FQDN =
      'other-pilot.servicebus.windows.net';
  },
}))
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => validateAcaPilot(f.runtime, f.pilot),
      /CONFIGURATION_INVALID/,
    );
  });
