import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, verifyOfficialSource, verifyOfficialImage, preparePlan, applyPlan, createAzureCloud, officialRepository } from './deploy-release.mjs';

const sha = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64), oldDigest = 'sha256:' + 'c'.repeat(64);
const registry = 'ghcr.io/' + officialRepository.toLowerCase();
const release = () => parseRelease(`api-gateway|${sha}|${digest}\ncatalog-svc|${sha}|${digest}`, sha);
const metadata = { subscription: '11111111-1111-4111-8111-111111111111', resourceGroup: 'rg-test' };
const clone = value => structuredClone(value);
function app(service) {
  return { identity: { type: 'SystemAssigned' }, properties: {
    latestRevisionName: service + '--before', latestReadyRevisionName: service + '--before',
    configuration: { activeRevisionsMode: 'Single', ingress: { external: service === 'api-gateway', fqdn: 'example.azurecontainerapps.io' }, secrets: [{ name: 'db-password' }] },
    template: { revisionSuffix: 'before', scale: { minReplicas: 1, maxReplicas: 1 }, containers: [
      { name: service, image: `${registry}/${service}@${oldDigest}`, env: [{ name: 'G6_SECURITY_MODE', value: 'PUBLIC_READ_ONLY' }, { name: 'PASSWORD', secretRef: 'db-password' }], resources: { cpu: 0.25, memory: '0.5Gi' }, probes: [{ type: 'Readiness', httpGet: { path: '/health/readiness', port: 3000 } }] },
      { name: 'sidecar', image: 'example-sidecar@sha256:' + 'd'.repeat(64), env: [{ name: 'PRESERVE', value: 'private-runtime-fixture' }] },
    ] },
  } };
}
function cloudFixture(behavior = {}) {
  const state = new Map(release().map(row => [row.service, app(row.service)]));
  const writes = [];
  return { state, writes, async read(service) { return clone(state.get(service)); },
    async patch(service, body) {
      writes.push({ service, body: clone(body) });
      state.get(service).properties.template = clone(body.properties.template);
      if (behavior.ambiguous && writes.length === 1) throw new Error('ARM_RESPONSE_LOST');
      if (behavior.rollbackFailure && writes.length > 2) throw new Error('ARM_PATCH_UNAVAILABLE');
    },
    async wait(service, revision) {
      const props = state.get(service).properties;
      props.latestRevisionName = revision; props.latestReadyRevisionName = revision;
      if (behavior.drift && writes.length === 1) props.template.containers[0].env.push({ name: 'OWNER_CHANGE', value: 'do-not-overwrite' });
    },
  };
}

test('manifest orders providers before Gateway and rejects malformed, mixed and duplicate releases', () => {
  assert.deepEqual(release().map(row => row.service), ['catalog-svc', 'api-gateway']);
  for (const bad of ['', `catalog-svc|${sha}|${digest}\ncatalog-svc|${sha}|${digest}`, `catalog-svc|${'f'.repeat(40)}|${digest}`, `catalog-svc|${sha}|latest`, `other-svc|${sha}|${digest}`, `catalog-svc|${sha}|${digest}|extra`]) assert.throws(() => parseRelease(bad, sha));
  assert.throws(() => parseRelease(`catalog-svc|${sha}|${digest}`, 'not-a-sha'));
});

function ciApi(change = {}) {
  return async path => path.includes('/commits/') ? { sha } : { workflow_runs: [{ id: 42, head_sha: sha, head_branch: 'master', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: officialRepository }, ...change }] };
}
test('requires the successful official postmerge CI for the exact source', async () => {
  assert.equal((await verifyOfficialSource(sha, ciApi())).ciRun, 42);
  await assert.rejects(verifyOfficialSource(sha, async () => ({ sha: 'f'.repeat(40) })), /SOURCE_IS_NOT_OFFICIAL_MASTER/);
});
for (const change of [{ event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' }, { head_sha: 'f'.repeat(40) }, { head_branch: 'cueva' }, { head_repository: { full_name: 'AXL031/G6-Productos-Ofertas-backend' } }]) {
  test('rejects non-authoritative CI ' + JSON.stringify(change), async () => assert.rejects(verifyOfficialSource(sha, ciApi(change)), /OFFICIAL_POSTMERGE_CI_NOT_SUCCESSFUL/));
}

test('requires official digest, service, revision, source and platform from the pulled image', () => {
  const row = release()[0];
  const image = { Os: 'linux', Architecture: 'amd64', RepoDigests: [row.image], Config: { Labels: { 'org.opencontainers.image.source': 'https://github.com/' + officialRepository, 'org.opencontainers.image.revision': sha, 'org.opencontainers.image.title': row.service } } };
  verifyOfficialImage(row, image);
  for (const mutate of [copy => { copy.Os = 'windows'; }, copy => { copy.Architecture = 'arm64'; }, copy => { copy.RepoDigests = []; }, copy => { copy.Config.Labels['org.opencontainers.image.source'] = 'https://github.com/AXL031/G6-Productos-Ofertas-backend'; }, copy => { copy.Config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40); }, copy => { copy.Config.Labels['org.opencontainers.image.title'] = 'wrong-service'; }]) {
    const copy = clone(image); mutate(copy);
    assert.throws(() => verifyOfficialImage(row, copy), /OFFICIAL_IMAGE_PROVENANCE_MISMATCH/);
  }
});

test('plan performs no writes and does not serialize env, sidecars or secret references', async () => {
  const cloud = cloudFixture();
  const plan = await preparePlan(release(), cloud, metadata);
  assert.equal(cloud.writes.length, 0);
  assert.equal(plan.apps.length, 2);
  assert.ok(plan.apps.every(row => row.changed));
  for (const secret of ['private-runtime-fixture', 'PUBLIC_READ_ONLY', 'db-password']) assert.ok(!JSON.stringify(plan).includes(secret));
});
for (const [name, mutate] of [['multiple revisions', props => { props.configuration.activeRevisionsMode = 'Multiple'; }], ['unready baseline', props => { props.latestReadyRevisionName = 'older'; }], ['fork image', props => { props.template.containers[0].image = 'ghcr.io/axl031/fork:latest'; }]]) {
  test('refuses unsupported baseline: ' + name, async () => {
    const cloud = cloudFixture(); mutate(cloud.state.get('api-gateway').properties);
    await assert.rejects(preparePlan(release(), cloud, metadata));
    assert.equal(cloud.writes.length, 0);
  });
}

test('image update preserves env, secrets, probes, resources, sidecars and ingress', async () => {
  const cloud = cloudFixture(), before = clone(cloud.state.get('catalog-svc'));
  const plan = await preparePlan(release(), cloud, metadata);
  const report = await applyPlan(plan, cloud, 'gh-fixture', async () => ({ health: 200 }));
  assert.equal(report.status, 'DEPLOYED_CONTROLPLANE_AND_HTTP_SMOKE');
  assert.deepEqual(cloud.writes.map(row => row.service), ['catalog-svc', 'api-gateway']);
  for (const row of cloud.writes) assert.deepEqual(Object.keys(row.body.properties), ['template']);
  const after = clone(cloud.state.get('catalog-svc'));
  after.properties.template.revisionSuffix = before.properties.template.revisionSuffix;
  after.properties.template.containers[0].image = before.properties.template.containers[0].image;
  after.properties.latestRevisionName = before.properties.latestRevisionName;
  after.properties.latestReadyRevisionName = before.properties.latestReadyRevisionName;
  assert.deepEqual(after, before);
});

test('baseline drift in the last app prevents all writes', async () => {
  const cloud = cloudFixture(), plan = await preparePlan(release(), cloud, metadata);
  cloud.state.get('api-gateway').properties.template.scale.minReplicas = 2;
  await assert.rejects(applyPlan(plan, cloud, 'gh-fixture', async () => ({})), /RUNTIME_CHANGED_SINCE_PLAN/);
  assert.equal(cloud.writes.length, 0);
});
test('unchanged images do not create new revisions', async () => {
  const cloud = cloudFixture();
  for (const row of release()) cloud.state.get(row.service).properties.template.containers[0].image = row.image;
  const plan = await preparePlan(release(), cloud, metadata);
  const report = await applyPlan(plan, cloud, 'gh-fixture', async () => ({}));
  assert.equal(report.status, 'DEPLOYED_CONTROLPLANE_AND_HTTP_SMOKE'); assert.equal(cloud.writes.length, 0);
});
test('HTTP smoke failure restores images in reverse order', async () => {
  const cloud = cloudFixture(), plan = await preparePlan(release(), cloud, metadata);
  const report = await applyPlan(plan, cloud, 'gh-fixture', async () => { throw new Error('GATEWAY_HTTP_SMOKE_FAILED'); });
  assert.equal(report.status, 'FAILED_IMAGES_RESTORED');
  assert.deepEqual(report.rollback.map(row => row.service), ['api-gateway', 'catalog-svc']);
  for (const row of plan.apps) assert.equal(cloud.state.get(row.service).properties.template.containers[0].image, row.previousImage);
});
test('ambiguous PATCH is reconciled by image restoration, without replaying business actions', async () => {
  const cloud = cloudFixture({ ambiguous: true }), plan = await preparePlan(release(), cloud, metadata);
  const report = await applyPlan(plan, cloud, 'gh-fixture', async () => ({}));
  assert.equal(report.status, 'FAILED_IMAGES_RESTORED'); assert.equal(cloud.writes.length, 2);
  assert.equal(cloud.state.get('catalog-svc').properties.template.containers[0].image, plan.apps[0].previousImage);
});
test('foreign configuration changes require manual review instead of being overwritten by rollback', async () => {
  const cloud = cloudFixture({ drift: true }), plan = await preparePlan(release(), cloud, metadata);
  const report = await applyPlan(plan, cloud, 'gh-fixture', async () => ({}));
  assert.equal(report.status, 'FAILED_ROLLBACK_INCOMPLETE'); assert.equal(cloud.writes.length, 1);
  assert.equal(cloud.state.get('catalog-svc').properties.template.containers[0].env.at(-1).name, 'OWNER_CHANGE');
});
test('failed image restoration is reported, never a successful deployment', async () => {
  const cloud = cloudFixture({ rollbackFailure: true }), plan = await preparePlan(release(), cloud, metadata);
  const report = await applyPlan(plan, cloud, 'gh-fixture', async () => { throw new Error('GATEWAY_HTTP_SMOKE_FAILED'); });
  assert.equal(report.status, 'FAILED_ROLLBACK_INCOMPLETE');
  assert.ok(report.rollback.some(row => row.status === 'MANUAL_REVIEW_REQUIRED'));
});
test('Azure target and service are constrained before a request is sent', async () => {
  assert.throws(() => createAzureCloud('$(unsafe)', 'rg-test', 'fixture'), /INVALID_AZURE_TARGET/);
  const cloud = createAzureCloud(metadata.subscription, metadata.resourceGroup, 'fixture', () => { throw new Error('UNEXPECTED_NETWORK'); });
  await assert.rejects(cloud.read('../other-resource'), /INVALID_SERVICE/);
});

const pricingKey = 'CATALOG_PRICING_URL';
const origin = 'https://pricing-svc.internal.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io';
const options = { configureCatalogPricing: true };
function configuredCloud() {
  const cloud = cloudFixture();
  const environmentId = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/aca-test';
  cloud.state.get('catalog-svc').properties.environmentId = environmentId;
  const pricing = app('pricing-svc');
  pricing.properties.environmentId = environmentId;
  pricing.properties.configuration.ingress = { external: false, allowInsecure: false, targetPort: 3002, fqdn: new URL(origin).hostname };
  cloud.state.set('pricing-svc', pricing);
  return cloud;
}
const catalogEnv = cloud => cloud.state.get('catalog-svc').properties.template.containers[0].env;

test('explicit configuration plan derives Pricing only from the private app in the same ACA environment', async () => {
  const cloud = configuredCloud();
  const plan = await preparePlan(release(), cloud, metadata, options);
  assert.equal(cloud.writes.length, 0);
  assert.deepEqual(plan.apps[0].pricingConfiguration, { previous: null, desired: { name: pricingKey, value: origin }, position: -1 });
  for (const privateValue of ['private-runtime-fixture', 'PUBLIC_READ_ONLY', 'db-password']) assert.ok(!JSON.stringify(plan).includes(privateValue));
  assert.equal(plan.apps[1].pricingConfiguration, undefined);
});

test('Catalog image and Pricing URL change in one PATCH, preserving sidecars, ingress and all other env', async () => {
  const cloud = configuredCloud(), before = clone(cloud.state.get('catalog-svc'));
  const plan = await preparePlan(release(), cloud, metadata, options);
  const report = await applyPlan(plan, cloud, 'gh-config', async () => ({}));
  assert.equal(report.status, 'DEPLOYED_CONTROLPLANE_AND_HTTP_SMOKE');
  const patches = cloud.writes.filter(row => row.service === 'catalog-svc');
  assert.equal(patches.length, 1);
  const updated = patches[0].body.properties.template;
  assert.equal(updated.containers[0].image, release()[0].image);
  assert.deepEqual(updated.containers[0].env.at(-1), { name: pricingKey, value: origin });
  updated.containers[0].env.pop();
  updated.containers[0].image = before.properties.template.containers[0].image;
  updated.revisionSuffix = before.properties.template.revisionSuffix;
  assert.deepEqual(updated, before.properties.template);
  assert.deepEqual(Object.keys(patches[0].body.properties), ['template']);
});

test('configuration-only change creates one revision even when the Catalog image is already current', async () => {
  const cloud = configuredCloud();
  for (const row of release()) cloud.state.get(row.service).properties.template.containers[0].image = row.image;
  const plan = await preparePlan(release(), cloud, metadata, options);
  assert.equal(plan.apps[0].changed, true);
  await applyPlan(plan, cloud, 'gh-config', async () => ({}));
  assert.deepEqual(cloud.writes.map(row => row.service), ['catalog-svc']);
});

for (const previous of [null, { name: pricingKey, value: 'http://pricing-svc:3002' }, { name: pricingKey, secretRef: 'e-catalog-pricing-url' }]) {
  test('rollback restores the previous image AND the exact Pricing env/reference: ' + (previous?.secretRef ?? previous?.value ?? 'absent'), async () => {
    const cloud = configuredCloud();
    if (previous) catalogEnv(cloud).splice(1, 0, clone(previous));
    const before = clone(cloud.state.get('catalog-svc').properties.template);
    const plan = await preparePlan(release(), cloud, metadata, options);
    const report = await applyPlan(plan, cloud, 'gh-config', async () => { throw new Error('GATEWAY_HTTP_SMOKE_FAILED'); });
    assert.equal(report.status, 'FAILED_IMAGES_AND_CONFIG_RESTORED');
    assert.equal(report.rollback.find(row => row.service === 'catalog-svc').status, 'IMAGE_AND_CONFIG_RESTORED');
    const after = clone(cloud.state.get('catalog-svc').properties.template);
    after.revisionSuffix = before.revisionSuffix;
    assert.deepEqual(after, before);
  });
}

for (const [name, change] of [
  ['external ingress', cloud => { cloud.state.get('pricing-svc').properties.configuration.ingress.external = true; }],
  ['insecure ingress', cloud => { cloud.state.get('pricing-svc').properties.configuration.ingress.allowInsecure = true; }],
  ['other environment', cloud => { cloud.state.get('pricing-svc').properties.environmentId += '-other'; }],
  ['wrong port', cloud => { cloud.state.get('pricing-svc').properties.configuration.ingress.targetPort = 80; }],
  ['arbitrary destination', cloud => { cloud.state.get('pricing-svc').properties.configuration.ingress.fqdn = 'example.test'; }],
  ['duplicate variable', cloud => { catalogEnv(cloud).push({ name: pricingKey, value: origin }, { name: pricingKey, value: origin }); }],
  ['unsafe previous value', cloud => { catalogEnv(cloud).push({ name: pricingKey, value: 'private-password-fixture' }); }],
  ['invalid secret reference type', cloud => { catalogEnv(cloud).push({ name: pricingKey, secretRef: 123, value: origin }); }],
]) {
  test('configuration refuses ' + name + ' without writes', async () => {
    const cloud = configuredCloud(); change(cloud);
    await assert.rejects(preparePlan(release(), cloud, metadata, options));
    assert.equal(cloud.writes.length, 0);
  });
}

test('configuration flag cannot select other services or arbitrary env changes', async () => {
  await assert.rejects(preparePlan(release().filter(row => row.service !== 'catalog-svc'), configuredCloud(), metadata, options), /CATALOG_CONFIGURATION_SCOPE_REQUIRED/);
  await assert.rejects(preparePlan(release(), configuredCloud(), metadata, { configureCatalogPricing: 'true' }), /CATALOG_CONFIGURATION_SCOPE_REQUIRED/);
});

test('Pricing target drift before apply prevents every write', async () => {
  const cloud = configuredCloud(), plan = await preparePlan(release(), cloud, metadata, options);
  cloud.state.get('pricing-svc').properties.configuration.ingress.fqdn = 'pricing-svc.internal.other.chilecentral.azurecontainerapps.io';
  await assert.rejects(applyPlan(plan, cloud, 'gh-config', async () => ({})), /RUNTIME_CHANGED_SINCE_PLAN/);
  assert.equal(cloud.writes.length, 0);
});

test('rollback refuses an owner change to the Pricing variable rather than overwriting it', async () => {
  const cloud = configuredCloud(), plan = await preparePlan(release(), cloud, metadata, options);
  const ownerValue = 'https://pricing-svc.internal.owner.chilecentral.azurecontainerapps.io';
  const report = await applyPlan(plan, cloud, 'gh-config', async () => {
    catalogEnv(cloud).find(row => row.name === pricingKey).value = ownerValue;
    throw new Error('GATEWAY_HTTP_SMOKE_FAILED');
  });
  assert.equal(report.status, 'FAILED_ROLLBACK_INCOMPLETE');
  assert.equal(report.rollback.find(row => row.service === 'catalog-svc').status, 'MANUAL_REVIEW_REQUIRED');
  assert.equal(catalogEnv(cloud).find(row => row.name === pricingKey).value, ownerValue);
});
