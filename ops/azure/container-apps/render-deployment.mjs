import { validatePhase3Runtime } from './phase3-preflight.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';

export const services = [
  'api-gateway',
  'catalog-svc',
  'taxonomy-svc',
  'pricing-svc',
  'price-audit-svc',
  'promotions-svc',
  'inventory-svc',
  'combos-svc',
  'bulk-svc',
];
const ports = [3000, 3001, 3006, 3002, 3003, 3004, 3005, 3007, 3008];
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
const policy = JSON.parse(
  readFileSync(new URL('./phase1-operations.json', import.meta.url), 'utf8'),
).operations.filter((r) => r.phase1Selected);
const apiVersion = '2025-01-01';
const environmentId =
  "[resourceId('Microsoft.App/managedEnvironments', parameters('environmentName'))]";
const edgeConfig = `{
 admin off
 auto_https off
}
:8080 {
 request_body {
  max_size 10MB
 }
 header {
  X-Content-Type-Options nosniff
  X-Frame-Options DENY
  Referrer-Policy no-referrer
  -Server
 }
 @published path /health /api/v1/*
 handle @published {
  reverse_proxy 127.0.0.1:3000 {
   transport http {
    dial_timeout 3s
    response_header_timeout 45s
   }
  }
 }
 handle {
  respond 404
 }
}
`;

export class PlanError extends Error {}
const fail = (code) => {
  throw new PlanError(code);
};

export function parseRelease(text) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map((line) => line.split('|'));
  if (rows.length !== services.length) fail('RELEASE_REQUIRES_NINE_SERVICES');
  const release = {};
  for (const [service, sha, digest, extra] of rows) {
    if (
      !services.includes(service) ||
      release[service] ||
      extra !== undefined ||
      !/^[a-f0-9]{40}$/.test(sha ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')
    )
      fail('INVALID_RELEASE_ROW');
    release[service] = { sha, digest };
  }
  if (new Set(Object.values(release).map((row) => row.sha)).size !== 1)
    fail('MIXED_APPLICATION_SHA');
  return release;
}

function upstream(service) {
  return `[concat('https://${service}.internal.', reference(resourceId('Microsoft.App/managedEnvironments', parameters('environmentName')), '${apiVersion}').defaultDomain)]`;
}

/** Pure ARM rendering. Caller must verify official workflows/OCI labels/digests
 * before invoking Azure. No registry publication, provisioning or DB calls here.
 * Platform TCP readiness is transport only; business readiness is tested separately.
 */
export function makeDeployment({
  release,
  runtime,
  ca,
  registryUser,
  registryPassword,
  caddyImage,
  enablePublicReads = false,
}) {
  if (!registryUser || !registryPassword)
    fail('REGISTRY_READ_CREDENTIALS_REQUIRED');
  if (!/^caddy:2\.11\.6-alpine@sha256:[a-f0-9]{64}$/.test(caddyImage ?? ''))
    fail('PINNED_OFFICIAL_CADDY_REQUIRED');
  try {
    new X509Certificate(ca);
  } catch {
    fail('VALID_POSTGRES_CA_REQUIRED');
  }
  const sourceSha = release?.['api-gateway']?.sha;
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha ?? '') ||
    services.some(
      (s) =>
        release[s]?.sha !== sourceSha ||
        !/^sha256:[a-f0-9]{64}$/.test(release[s]?.digest ?? ''),
    )
  )
    fail('VERIFIABLE_RELEASE_REQUIRED');
  const mode = runtime?.['api-gateway']?.G6_SECURITY_MODE;
  if (!['PUBLIC_READ_ONLY', 'G7_AUTHENTICATED'].includes(mode))
    fail('CLOUD_MODE_NOT_ALLOWED');
  if (mode === 'PUBLIC_READ_ONLY' && !enablePublicReads)
    fail('PUBLIC_READS_REQUIRE_EXPLICIT_SELECTION');
  const cleanRuntime = {};
  for (const [index, service] of services.entries()) {
    const env = runtime?.[service];
    if (
      !env ||
      env.NODE_ENV !== 'production' ||
      env.G6_SECURITY_MODE !== mode ||
      Object.entries(env).some(
        ([key, value]) =>
          !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string',
      )
    )
      fail('INVALID_RUNTIME_' + service);
    if (
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      [
        'GATEWAY_DEMO_NO_AUTH_ENABLED',
        'G6_READ_ONLY_DEMO_ENABLED',
        'ALLOW_DEMO_UNAUTHENTICATED',
        'INVENTORY_DEMO_NO_AUTH_ENABLED',
        'COMBOS_RESTRICTED_DEMO_ENABLED',
      ].some((key) => env[key] === 'true')
    )
      fail('LEGACY_OR_TLS_BYPASS_REJECTED');
    const key =
      service === 'combos-svc'
        ? 'COMBOS_PUBLIC_READ_OPERATIONS'
        : prefixes[index] + '_PUBLIC_OPERATION_IDS';
    const selected = (env[key] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const expected =
      mode === 'PUBLIC_READ_ONLY'
        ? policy
            .filter((r) => index === 0 || r.service === service)
            .map((r) => r.operationId)
        : [];
    if (
      selected.length !== expected.length ||
      new Set(selected).size !== selected.length ||
      selected.some((id) => !expected.includes(id))
    )
      fail('EXACT_PUBLIC_SCOPE_REQUIRED_' + service);
    if (
      index > 0 &&
      (env.PGSSLMODE !== 'verify-full' ||
        env.PGSSLROOTCERT !== '/run/g6-certs/supabase-server-root.crt' ||
        !env.PGPASSWORD)
    )
      fail('POSTGRES_TLS_AND_ROLE_REQUIRED_' + service);
    cleanRuntime[service] = Object.fromEntries(
      Object.entries(env).filter(([, v]) => v !== ''),
    );
  }
  if (mode === 'G7_AUTHENTICATED') validatePhase3Runtime(cleanRuntime);
  const resources = [
    {
      type: 'Microsoft.App/managedEnvironments',
      apiVersion: '2026-07-01',
      name: "[parameters('environmentName')]",
      location: 'chilecentral',
      tags: { project: 'g6-phase1-aca' },
      properties: {
        environmentMode: 'WorkloadProfiles',
        appLogsConfiguration: { destination: null },
        workloadProfiles: [
          { name: 'Consumption', workloadProfileType: 'Consumption' },
        ],
        zoneRedundant: false,
      },
    },
  ];
  for (const [index, service] of services.entries()) {
    const env = cleanRuntime[service],
      overrides = {};
    if (index === 0) {
      env.GATEWAY_TIMEOUT_MS = '30000';
      for (const target of services.slice(1))
        overrides[
          'GATEWAY_' + target.replaceAll('-', '_').toUpperCase() + '_URL'
        ] = upstream(target);
    }
    if (service === 'catalog-svc')
      overrides.CATALOG_TAXONOMY_URL = upstream('taxonomy-svc');
    if (service === 'pricing-svc')
      overrides.PRICING_CATALOG_URL = upstream('catalog-svc');
    if (service === 'combos-svc') {
      overrides.COMBOS_CATALOG_URL = upstream('catalog-svc');
      overrides.COMBOS_PRICING_URL = upstream('pricing-svc');
    }
    if (service === 'promotions-svc')
      for (const target of ['catalog', 'taxonomy', 'pricing', 'inventory'])
        overrides['GATEWAY_' + target.toUpperCase() + '_SVC_URL'] = upstream(
          target + '-svc',
        );
    const keys = [...new Set([...Object.keys(env), ...Object.keys(overrides)])];
    const secretName = (key) => 'e-' + key.toLowerCase().replaceAll('_', '-');
    const secrets = keys.map((key) => ({
      name: secretName(key),
      value:
        overrides[key] ?? `[parameters('runtime')['${service}']['${key}']]`,
    }));
    secrets.push({
      name: 'ghcr-pull',
      value: "[parameters('registryPassword')]",
    });
    const volumes = [],
      volumeMounts = [];
    if (index > 0) {
      secrets.push({
        name: 'postgres-ca',
        value: "[parameters('postgresCa')]",
      });
      volumes.push({
        name: 'postgres-ca',
        storageType: 'Secret',
        secrets: [
          { secretRef: 'postgres-ca', path: 'supabase-server-root.crt' },
        ],
      });
      volumeMounts.push({
        volumeName: 'postgres-ca',
        mountPath: '/run/g6-certs',
      });
    }
    const containers = [
      {
        name: service,
        image: `ghcr.io/taller-sw-web/g6-productos-ofertas-backend/${service}@${release[service].digest}`,
        env: keys.map((key) => ({ name: key, secretRef: secretName(key) })),
        resources: { cpu: 0.25, memory: '0.5Gi' },
        volumeMounts,
        probes: [
          {
            type: 'Startup',
            tcpSocket: { port: ports[index] },
            initialDelaySeconds: 5,
            periodSeconds: 5,
            timeoutSeconds: 5,
            failureThreshold: 60,
          },
          {
            type: 'Liveness',
            httpGet: { path: '/health', port: ports[index], scheme: 'HTTP' },
            initialDelaySeconds: 10,
            periodSeconds: 30,
            timeoutSeconds: 5,
            failureThreshold: 3,
          },
        ],
      },
    ];
    if (index === 0) {
      secrets.push({ name: 'edge-config', value: edgeConfig });
      volumes.push({
        name: 'edge-config',
        storageType: 'Secret',
        secrets: [{ secretRef: 'edge-config', path: 'Caddyfile' }],
      });
      containers.push({
        name: 'caddy',
        image: caddyImage,
        command: [
          'caddy',
          'run',
          '--config',
          '/etc/caddy/Caddyfile',
          '--adapter',
          'caddyfile',
        ],
        resources: { cpu: 0.25, memory: '0.5Gi' },
        volumeMounts: [{ volumeName: 'edge-config', mountPath: '/etc/caddy' }],
      });
    }
    resources.push({
      type: 'Microsoft.App/containerApps',
      apiVersion,
      name: service,
      location: 'chilecentral',
      tags: {
        project: 'g6-phase1-aca',
        applicationSha: sourceSha,
        readinessScope: 'transport-business-checks-separate',
      },
      dependsOn: [
        environmentId,
        ...(index === 0
          ? services
              .slice(1)
              .map((s) => `[resourceId('Microsoft.App/containerApps','${s}')]`)
          : []),
      ],
      properties: {
        managedEnvironmentId: environmentId,
        workloadProfileName: 'Consumption',
        configuration: {
          activeRevisionsMode: 'Single',
          ingress: {
            external: index === 0,
            targetPort: index === 0 ? 8080 : ports[index],
            allowInsecure: false,
            transport: 'auto',
            traffic: [{ latestRevision: true, weight: 100 }],
          },
          registries: [
            {
              server: 'ghcr.io',
              username: "[parameters('registryUser')]",
              passwordSecretRef: 'ghcr-pull',
            },
          ],
          secrets,
        },
        template: {
          revisionSuffix: 'r-' + sourceSha.slice(0, 10),
          containers,
          volumes,
          scale: {
            minReplicas: 0,
            maxReplicas: 1,
            rules: [
              { name: 'http', http: { metadata: { concurrentRequests: '5' } } },
            ],
          },
        },
      },
    });
  }
  return {
    template: {
      $schema:
        'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      parameters: {
        environmentName: {
          type: 'string',
          defaultValue: 'env-g6-phase1-chile',
        },
        registryUser: { type: 'string' },
        registryPassword: { type: 'secureString' },
        postgresCa: { type: 'secureString' },
        runtime: { type: 'secureObject' },
      },
      resources,
      outputs: {
        gatewayUrl: {
          type: 'string',
          value: `[concat('https://',reference(resourceId('Microsoft.App/containerApps','api-gateway'),'${apiVersion}').configuration.ingress.fqdn)]`,
        },
        applicationSha: { type: 'string', value: sourceSha },
      },
    },
    parameters: {
      $schema:
        'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
      contentVersion: '1.0.0.0',
      parameters: {
        registryUser: { value: registryUser },
        registryPassword: { value: registryPassword },
        postgresCa: { value: ca },
        runtime: { value: cleanRuntime },
      },
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2),
      option = (key) => args[args.indexOf(key) + 1];
    if (
      [
        '--release',
        '--runtime',
        '--ca',
        '--registry-user',
        '--caddy-image',
        '--out',
      ].some(
        (key) =>
          !args.includes(key) || !option(key) || option(key).startsWith('--'),
      )
    )
      fail('REQUIRED_OPTIONS_MISSING');
    const release = parseRelease(readFileSync(option('--release'), 'utf8'));
    const runtime = Object.fromEntries(
      services.map((service) => [
        service,
        JSON.parse(
          readFileSync(
            join(option('--runtime'), service + '.runtime.private.json'),
            'utf8',
          ),
        ),
      ]),
    );
    const plan = makeDeployment({
      release,
      runtime,
      ca: readFileSync(option('--ca'), 'utf8'),
      registryUser: option('--registry-user'),
      registryPassword: process.env.G6_GHCR_PULL_TOKEN,
      caddyImage: option('--caddy-image'),
      enablePublicReads: args.includes('--enable-public-reads'),
    });
    mkdirSync(option('--out'), { recursive: true });
    writeFileSync(
      join(option('--out'), 'deployment.json'),
      JSON.stringify(plan.template, null, 2) + '\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(option('--out'), 'parameters.private.json'),
      JSON.stringify(plan.parameters, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        status: 'RENDERED_NOT_DEPLOYED',
        services: services.length,
        sourceSha: release['api-gateway'].sha,
        maximumVcpu: 2.5,
        maximumMemoryGiB: 5,
        minReplicas: 0,
        maxReplicas: 1,
        credentialValuesPrinted: false,
      }),
    );
  } catch (error) {
    console.error(
      error instanceof PlanError
        ? error.message
        : 'PRIVATE_INPUT_OR_OUTPUT_ERROR',
    );
    process.exitCode = 1;
  }
}
