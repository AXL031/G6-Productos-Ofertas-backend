import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePilotParameters } from './validate-pilot.mjs';

const fixture = () => ({
  parameters: {
    namespaceName: { value: 'g6-pilot-test' },
    location: { value: 'chilecentral' },
    pricingPrincipalId: { value: '11111111-1111-4111-8111-111111111111' },
    auditPrincipalId: { value: '22222222-2222-4222-8222-222222222222' },
  },
});
test('validates the explicit single-queue pilot without provisioning', () => {
  assert.equal(
    validatePilotParameters(fixture()).queue,
    'g6.price-audit.from.pricing',
  );
});
test('rejects a shared runtime identity, including case differences', () => {
  const value = fixture();
  value.parameters.auditPrincipalId.value =
    value.parameters.pricingPrincipalId.value;
  assert.throws(() => validatePilotParameters(value), /SEPARATE_WORKLOAD/);
});
test('rejects zero identities and missing region', () => {
  const value = fixture();
  value.parameters.pricingPrincipalId.value =
    '00000000-0000-0000-0000-000000000000';
  assert.throws(() => validatePilotParameters(value), /VALID_WORKLOAD/);
  value.parameters.location.value = '';
  assert.throws(() => validatePilotParameters(value), /EXPLICIT_REGION/);
});
test('rejects unapproved options and delivery count', () => {
  const value = fixture();
  value.parameters.maxDeliveryCount = { value: 0 };
  assert.throws(() => validatePilotParameters(value), /INVALID_MAX/);
  delete value.parameters.maxDeliveryCount;
  value.parameters.connectionString = { value: 'forbidden' };
  assert.throws(() => validatePilotParameters(value), /UNEXPECTED/);
});
test('manifest and IaC refer to exactly the implemented pilot queue', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('./pilot-route.json', import.meta.url), 'utf8'),
  );
  const bicep = readFileSync(new URL('./main.bicep', import.meta.url), 'utf8');
  assert.equal(manifest.productionActivation, false);
  assert.equal(manifest.destination, validatePilotParameters(fixture()).queue);
  assert(bicep.includes(`'${manifest.destination}'`));
  for (const property of [
    'defaultMessageTimeToLive',
    'requiresSession',
    'requiresDuplicateDetection',
    'forwardTo',
    'autoDeleteOnIdle',
  ])
    assert(
      !bicep.includes(property),
      `Unsupported Basic property: ${property}`,
    );
});
