import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const officialRepository = 'Taller-SW-Web/G6-Productos-Ofertas-backend';
export const services = ['catalog-svc', 'taxonomy-svc', 'pricing-svc', 'price-audit-svc', 'inventory-svc', 'combos-svc', 'bulk-svc', 'promotions-svc', 'api-gateway'];
const registry = 'ghcr.io/' + officialRepository.toLowerCase();
const version = '2025-01-01';
const fail = code => { throw new Error(code); };
const clone = value => structuredClone(value);
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');

export function parseRelease(text, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) fail('INVALID_OFFICIAL_SHA');
  const rows = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => line.split('|'));
  const found = new Set();
  for (const row of rows) {
    if (row.length !== 3 || !services.includes(row[0]) || found.has(row[0]) || row[1] !== sha || !/^sha256:[a-f0-9]{64}$/.test(row[2])) fail('INVALID_RELEASE_MANIFEST');
    found.add(row[0]);
  }
  if (!rows.length) fail('EMPTY_RELEASE_MANIFEST');
  // Providers first, public Gateway last. Input order cannot change this.
  return services.filter(service => found.has(service)).map(service => {
    const row = rows.find(row => row[0] === service);
    return { service, sha, image: `${registry}/${service}@${row[2]}` };
  });
}

export async function verifyOfficialSource(sha, api) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) fail('INVALID_OFFICIAL_SHA');
  const head = await api(`/repos/${officialRepository}/commits/master`);
  if (head.sha !== sha) fail('SOURCE_IS_NOT_OFFICIAL_MASTER');
  const runs = await api(`/repos/${officialRepository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`);
  const ci = runs.workflow_runs?.find(run => run.head_sha === sha && run.head_branch === 'master' && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success' && run.head_repository?.full_name === officialRepository);
  if (!ci) fail('OFFICIAL_POSTMERGE_CI_NOT_SUCCESSFUL');
  return { repository: officialRepository, sha, ciRun: ci.id };
}

export function verifyOfficialImage(row, image) {
  const labels = image?.Config?.Labels;
  if (image?.Os !== 'linux' || image.Architecture !== 'amd64' || !image.RepoDigests?.includes(row.image) || labels?.['org.opencontainers.image.source']?.toLowerCase() !== 'https://github.com/' + officialRepository.toLowerCase() || labels?.['org.opencontainers.image.revision'] !== row.sha || labels?.['org.opencontainers.image.title'] !== row.service) fail('OFFICIAL_IMAGE_PROVENANCE_MISMATCH');
}

const pricingKey = 'CATALOG_PRICING_URL';
function pricingEnv(app) {
  const rows = app.properties.template.containers.find(c => c.name === 'catalog-svc')?.env?.filter(row => row.name === pricingKey) ?? [];
  if (rows.length > 1) fail('DUPLICATE_CATALOG_PRICING_ENV');
  if (!rows.length) return null;
  const row = rows[0];
  if ((row.secretRef !== undefined && typeof row.secretRef !== 'string') || Object.keys(row).some(key => !['name', 'value', 'secretRef'].includes(key)) ||
      (typeof row.secretRef === 'string' ? typeof row.value !== 'undefined' || !row.secretRef :
        typeof row.value !== 'string' || !/^(?:http:\/\/pricing-svc:3002|https:\/\/pricing-svc\.internal(?:\.[a-z0-9-]+){2,}\.azurecontainerapps\.io)\/?$/.test(row.value)))
    fail('UNSAFE_CATALOG_PRICING_BASELINE');
  return clone(row);
}
function pricingOrigin(catalog, pricing) {
  const environment = app => app.properties.environmentId ?? app.properties.managedEnvironmentId;
  const id = environment(catalog);
  const ingress = pricing.properties.configuration.ingress;
  if (typeof id !== 'string' || !/\/providers\/Microsoft.App\/managedEnvironments\/[^/]+$/i.test(id) ||
      typeof environment(pricing) !== 'string' || environment(pricing).toLowerCase() !== id.toLowerCase() ||
      ingress?.external !== false || ingress.allowInsecure === true || ingress.targetPort !== 3002 ||
      !/^pricing-svc\.internal(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){2,}\.azurecontainerapps\.io$/.test(ingress.fqdn ?? ''))
    fail('PRIVATE_PRICING_TARGET_REQUIRED');
  return 'https://' + ingress.fqdn;
}
function setPricingEnv(container, value, position) {
  const env = (container.env ?? []).filter(row => row.name !== pricingKey);
  if (value !== null) env.splice(position < 0 ? env.length : position, 0, clone(value));
  if (env.length || container.env) container.env = env;
}
function invariant(app, service, allowPricing = false) {
  const template = clone(app.properties.template);
  delete template.revisionSuffix;
  const container = template.containers?.find(container => container.name === service);
  if (!container || template.containers.filter(container => container.name === service).length !== 1) fail('RUNTIME_CONTAINER_NOT_FOUND');
  delete container.image;
  if (allowPricing) container.env = (container.env ?? []).filter(row => row.name !== pricingKey);
  // Only hashes and the explicitly selected nonsecret Pricing env/reference enter evidence.
  return hash({ template, configuration: app.properties.configuration, identity: app.identity });
}

function imageOf(app, service) {
  return app.properties.template.containers.find(container => container.name === service)?.image;
}

export async function preparePlan(release, cloud, metadata, { configureCatalogPricing = false } = {}) {
  if (typeof configureCatalogPricing !== 'boolean' || (configureCatalogPricing && !release.some(row => row.service === 'catalog-svc')))
    fail('CATALOG_CONFIGURATION_SCOPE_REQUIRED');
  const plan = { format: 1, ...metadata, source: officialRepository, sha: release[0]?.sha, apps: [] };
  for (const row of release) {
    const app = await cloud.read(row.service);
    const image = imageOf(app, row.service);
    if (!new RegExp('^' + registry.replaceAll('.', '\\.') + '/' + row.service + '@sha256:[a-f0-9]{64}$').test(image ?? '')) fail('BASELINE_NOT_AN_OFFICIAL_DIGEST');
    if ((app.properties.configuration.activeRevisionsMode ?? 'Single') !== 'Single') fail('MULTIPLE_REVISION_MODE_REQUIRES_OWN_ROLLOUT');
    if (app.properties.latestRevisionName !== app.properties.latestReadyRevisionName) fail('BASELINE_REVISION_NOT_READY');
    const config = configureCatalogPricing && row.service === 'catalog-svc' ? {
      previous: pricingEnv(app),
      desired: { name: pricingKey, value: pricingOrigin(app, await cloud.read('pricing-svc')) },
      position: app.properties.template.containers.find(c => c.name === row.service).env?.findIndex(e => e.name === pricingKey) ?? -1,
    } : undefined;
    plan.apps.push({ service: row.service, previousImage: image, previousRevision: app.properties.latestReadyRevisionName, image: row.image, invariant: invariant(app, row.service, !!config), changed: image !== row.image || (!!config && stable(config.previous) !== stable(config.desired)), ...(config ? { pricingConfiguration: config } : {}) });
  }
  return plan;
}

export async function applyPlan(plan, cloud, suffix, smoke) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(suffix)) fail('INVALID_REVISION_SUFFIX');
  const report = { sha: plan.sha, writes: [], rollback: [], status: 'PREFLIGHT' };
  // Check every baseline before writing the first app.
  for (const row of plan.apps) {
    const current = await cloud.read(row.service);
    if (imageOf(current, row.service) !== row.previousImage || invariant(current, row.service, !!row.pricingConfiguration) !== row.invariant ||
        (row.pricingConfiguration && (stable(pricingEnv(current)) !== stable(row.pricingConfiguration.previous) ||
          pricingOrigin(current, await cloud.read('pricing-svc')) !== row.pricingConfiguration.desired.value))) fail('RUNTIME_CHANGED_SINCE_PLAN');
  }
  const attempted = [];
  const update = async (row, image, revisionSuffix, restore = false) => {
    const current = await cloud.read(row.service);
    if (invariant(current, row.service, !!row.pricingConfiguration) !== row.invariant) fail('RUNTIME_CONFIGURATION_DRIFT');
    const config = row.pricingConfiguration;
    if (config && ![stable(config.previous), stable(config.desired)].includes(stable(pricingEnv(current)))) fail('CATALOG_PRICING_CONFIGURATION_DRIFT');
    if (config && !restore && pricingOrigin(current, await cloud.read('pricing-svc')) !== config.desired.value) fail('PRIVATE_PRICING_TARGET_CHANGED');
    const actual = imageOf(current, row.service);
    if (![row.previousImage, row.image].includes(actual)) fail('FOREIGN_IMAGE_CHANGE');
    const template = clone(current.properties.template);
    template.revisionSuffix = revisionSuffix;
    template.containers.find(container => container.name === row.service).image = image;
    const expectedEnv = config ? (restore ? config.previous : config.desired) : undefined;
    if (config) setPricingEnv(template.containers.find(c => c.name === row.service), expectedEnv, config.position);
    // PATCH contains template only. Never includes configuration/secrets or other resources.
    await cloud.patch(row.service, { properties: { template } });
    await cloud.wait(row.service, `${row.service}--${revisionSuffix}`);
    const after = await cloud.read(row.service);
    if (imageOf(after, row.service) !== image || invariant(after, row.service, !!config) !== row.invariant ||
        (config && stable(pricingEnv(after)) !== stable(expectedEnv))) fail('RUNTIME_CONFIGURATION_DRIFT');
  };
  try {
    for (const row of plan.apps.filter(row => row.changed)) {
      attempted.push(row); // An ambiguous PATCH may already have reached ARM.
      await update(row, row.image, suffix);
      report.writes.push({ service: row.service, image: row.image, revision: `${row.service}--${suffix}`, ...(row.pricingConfiguration ? { pricingConfigurationApplied: true } : {}) });
    }
    report.smoke = await smoke();
    report.status = 'DEPLOYED_CONTROLPLANE_AND_HTTP_SMOKE';
  } catch (error) {
    report.failure = safeCode(error);
    for (const row of attempted.reverse()) {
      try {
        await update(row, row.previousImage, suffix + '-r', true);
        report.rollback.push({ service: row.service, status: row.pricingConfiguration ? 'IMAGE_AND_CONFIG_RESTORED' : 'IMAGE_RESTORED' });
      } catch (rollbackError) { report.rollback.push({ service: row.service, status: 'MANUAL_REVIEW_REQUIRED', failure: safeCode(rollbackError) }); }
    }
    report.status = report.rollback.some(row => !['IMAGE_RESTORED', 'IMAGE_AND_CONFIG_RESTORED'].includes(row.status)) ? 'FAILED_ROLLBACK_INCOMPLETE' :
      report.rollback.some(row => row.status === 'IMAGE_AND_CONFIG_RESTORED') ? 'FAILED_IMAGES_AND_CONFIG_RESTORED' : 'FAILED_IMAGES_RESTORED';
  }
  return report;
}

function safeCode(error) { return /^[A-Z][A-Z0-9_]{1,90}$/.test(error.message ?? '') ? error.message : 'NETWORK_OR_COMMAND_FAILURE'; }
function command(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' }).trim(); }
  catch { fail('COMMAND_FAILED'); }
}

export function createAzureCloud(subscription, group, token, fetcher = fetch) {
  if (!/^[a-f0-9-]{36}$/.test(subscription ?? '') || !/^[a-zA-Z0-9_-]{1,80}$/.test(group ?? '')) fail('INVALID_AZURE_TARGET');
  const base = `https://management.azure.com/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.App/containerApps/`;
  async function arm(service, extra = '', body) {
    if (!services.includes(service)) fail('INVALID_SERVICE');
    const response = await fetcher(base + service + extra + '?api-version=' + version, { method: body ? 'PATCH' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (!response.ok) fail('ARM_HTTP_' + response.status);
    return response.json();
  }
  return {
    read: service => arm(service),
    patch: (service, body) => arm(service, '', body),
    async wait(service, revision) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const app = await arm(service);
        if (app.properties.provisioningState === 'Failed') fail('ARM_PROVISIONING_FAILED');
        if (app.properties.latestRevisionName === revision && app.properties.latestReadyRevisionName === revision) {
          const state = await arm(service, '/revisions/' + revision);
          if (state.properties.healthState === 'Healthy' && state.properties.provisioningState === 'Provisioned') return;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      fail('ARM_REVISION_READINESS_TIMEOUT');
    },
  };
}

async function smokeGateway(cloud) {
  const app = await cloud.read('api-gateway');
  const fqdn = app.properties.configuration.ingress?.fqdn;
  if (!app.properties.configuration.ingress?.external || !/^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(fqdn ?? '')) fail('INVALID_GATEWAY_INGRESS');
  const checks = [];
  for (const [path, headers, expected] of [['/health', {}, 200], ['/api/v1/productos?canal=MARKETPLACE&pagina=1&tamanio=1', { Authorization: 'Bearer invalid-workflow-negative-fixture' }, 401]]) {
    const response = await fetch('https://' + fqdn + path, { headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
    await response.arrayBuffer();
    checks.push({ path, http: response.status, expected });
    if (response.status !== expected) fail('GATEWAY_HTTP_SMOKE_FAILED');
  }
  return { checks, limitation: 'ARM readiness plus Gateway HTTP smoke; not business/M2M/AMQP certification' };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--release', '--sha', '--out', '--apply', '--configure-catalog-pricing'].includes(key) || Object.hasOwn(options, key.slice(2))) fail('INVALID_ARGUMENTS');
    const value = ['--apply', '--configure-catalog-pricing'].includes(key) ? true : args[++index];
    if (value !== true && (!value || value.startsWith('--'))) fail('INVALID_ARGUMENTS');
    options[key.slice(2)] = value;
  }
  if (!options.release || !options.out) fail('INVALID_ARGUMENTS');
  const release = parseRelease(readFileSync(resolve(options.release), 'utf8'), options.sha);
  const directory = resolve(options.out);
  mkdirSync(directory, { recursive: true });
  const api = async path => JSON.parse(command('gh', ['api', path]));
  const source = await verifyOfficialSource(options.sha, api);
  for (const row of release) {
    command('docker', ['pull', '--platform', 'linux/amd64', row.image]);
    verifyOfficialImage(row, JSON.parse(command('docker', ['image', 'inspect', row.image]))[0]);
  }
  const subscription = process.env.AZURE_SUBSCRIPTION_ID, group = process.env.AZURE_RESOURCE_GROUP;
  createAzureCloud(subscription, group, ''); // Validate before passing IDs to a CLI.
  const token = command('az', ['account', 'get-access-token', '--subscription', subscription ?? '', '--resource', 'https://management.azure.com/', '--query', 'accessToken', '-o', 'tsv', '--only-show-errors']);
  const cloud = createAzureCloud(subscription, group, token);
  const plan = await preparePlan(release, cloud, { subscription, resourceGroup: group, checkedAtUtc: new Date().toISOString(), officialCiRun: source.ciRun }, { configureCatalogPricing: options['configure-catalog-pricing'] === true });
  writeFileSync(resolve(directory, 'plan.json'), JSON.stringify(plan, null, 2));
  writeFileSync(resolve(directory, 'rollback-images.psv'), plan.apps.map(row => `${row.service}|${row.previousImage}`).join('\n') + '\n');
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'plan', sha: plan.sha, apps: plan.apps.map(row => ({ service: row.service, changed: row.changed })) }));
  if (args.includes('--apply')) {
    const id = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT;
    if (!/^\d{1,16}$/.test(id ?? '') || !/^\d{1,3}$/.test(attempt ?? '')) fail('WORKFLOW_CONTEXT_REQUIRED_FOR_APPLY');
    const report = await applyPlan(plan, cloud, `gh-${options.sha.slice(0, 7)}-${id}-${attempt}`, () => smokeGateway(cloud));
    writeFileSync(resolve(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, updated: report.writes.length, rollback: report.rollback }));
    if (report.status !== 'DEPLOYED_CONTROLPLANE_AND_HTTP_SMOKE') process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
