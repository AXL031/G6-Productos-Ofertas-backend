import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = process.argv[2];
if (!directory) throw new Error('PRIVATE_OUTPUT_DIRECTORY_REQUIRED');
const readJson = async (name) =>
  JSON.parse(
    (await readFile(resolve(directory, name), 'utf8')).replace(/^\uFEFF/, ''),
  );
const infrastructure = await readJson('infrastructure-result.json');
if (infrastructure.state !== 'Succeeded')
  throw new Error('INFRASTRUCTURE_NOT_DEPLOYED');
const outputs = infrastructure.outputs;
const namespace = outputs.namespaceFqdn.value;
if (!/^g6-sb-test-[a-z0-9-]+\.servicebus\.windows\.net$/.test(namespace))
  throw new Error('ISOLATED_NAMESPACE_REQUIRED');
const pricingId = outputs.pricingIdentityId.value;
const auditId = outputs.auditIdentityId.value;
const identityPath =
  /^\/subscriptions\/[0-9a-f-]+\/resourceGroups\/rg-g6-sb-pilot-[a-z0-9-]+\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/id-g6-sb-pilot-(pricing|audit)$/i;
if (
  !identityPath.test(pricingId) ||
  !identityPath.test(auditId) ||
  pricingId === auditId
)
  throw new Error('SEPARATE_ISOLATED_IDENTITIES_REQUIRED');
const bundle = await readJson('bundle.json');
if (!/^[0-9a-f]{64}$/.test(bundle.sha256) || !Array.isArray(bundle.chunks))
  throw new Error('INVALID_BUNDLE');
const parameters = {
  namespaceFqdn: { value: namespace },
  pricingIdentityId: { value: pricingId },
  auditIdentityId: { value: auditId },
  pricingClientId: { value: outputs.pricingClientId.value },
  auditClientId: { value: outputs.auditClientId.value },
  bundleSha256: { value: bundle.sha256 },
  bundle: { value: { chunks: bundle.chunks } },
  bootstrapCode: {
    value: await readFile(
      new URL('./cloud-bootstrap.cjs', import.meta.url),
      'utf8',
    ),
  },
  pricingTestPassword: { value: randomUUID() },
  auditTestPassword: { value: randomUUID() },
};
try {
  const manifest = await readJson('cleanup-manifest.json');
  if (
    manifest.namespace !== namespace ||
    !Array.isArray(manifest.messages) ||
    !manifest.messages.length
  )
    throw new Error('INVALID_CLEANUP_MANIFEST');
  parameters.cleanupManifest = { value: JSON.stringify(manifest) };
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await writeFile(
  resolve(directory, 'runner.parameters.private.json'),
  JSON.stringify({
    $schema:
      'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0',
    parameters,
  }),
  { mode: 0o600 },
);
process.stdout.write('PRIVATE_RUNNER_PARAMETERS_PREPARED\n');
