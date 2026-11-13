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
