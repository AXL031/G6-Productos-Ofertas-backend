// Read-only comparison against immutable official Docs. JSON is parsed from YAML
// during preparation; the original YAML Git blob is verified before comparison.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { httpContracts } from '../../../dist/apps/promotions-svc/http/http-contract.generated.js';

const docs = '4d285c5ffb91611b60385e0fab5a7295c95e3ed6';
const input = process.argv[2];
assert.ok(
  input?.endsWith('.json'),
  'Pass JSON parsed from the pinned official OpenAPI YAML',
);
const yaml = readFileSync(input.replace(/\.json$/, '.yaml'));
const gitBlob = createHash('sha1')
  .update(`blob ${yaml.length}\0`)
  .update(yaml)
  .digest('hex');
assert.equal(gitBlob, '6ff062c563d381d4bcf7976f223590b400ace4ec');
const doc = JSON.parse(readFileSync(input, 'utf8'));
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref)
    return resolve(
      value.$ref
        .slice(2)
        .split('/')
        .reduce((v, k) => v[k], doc),
    );
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k]) =>
          ![
            'description',
            'example',
            'examples',
            'x-source-spec',
            'x-business-result-codes',
          ].includes(k),
      )
      .map(([k, v]) => [k, resolve(v)]),
  );
}
const selected = new Set([
  'listarPromociones',
  'evaluarPromociones',
  'validarCupon',
  'obtenerRecomendaciones',
]);
const checks = [];
for (const [path, methods] of Object.entries(doc.paths))
  for (const [method, op] of Object.entries(methods)) {
    if (!selected.has(op.operationId)) continue;
    const parameters = resolve(op.parameters ?? []);
    const expected = JSON.parse(
      JSON.stringify({
        method: method.toUpperCase(),
        path: '/api/v1' + path,
        security: op.security.map((s) => Object.keys(s)[0]),
        scope: op['x-required-scope'],
        audience: op['x-service-audience'],
        clients: op['x-allowed-client-ids'],
        query: Object.fromEntries(
          parameters
            .filter((p) => p.in === 'query')
            .map((p) => [p.name, { required: !!p.required, schema: p.schema }]),
        ),
        body: resolve(op.requestBody?.content?.['application/json']?.schema),
        response: resolve(
          op.responses['200'].content['application/json'].schema,
        ),
        errors: op['x-error-codes'],
      }),
    );
    assert.deepEqual(httpContracts[op.operationId], expected, op.operationId);
    checks.push({
      operation: op.operationId,
      status: 'PASS',
      method: expected.method,
      path: expected.path,
      scope: expected.scope,
      clients: expected.clients,
    });
  }
assert.equal(checks.length, 4);
const operationClients = httpContracts.obtenerRecomendaciones.clients;
const pendingRegistrationClients =
  doc['x-security-contract'].service_scopes_pending_registration[
    'recomendaciones:leer'
  ].clients;
assert.deepEqual(pendingRegistrationClients, ['modulo-chatbot']);
console.log(
  JSON.stringify(
    {
      docs,
      openapi: doc.info.version,
      yamlSha256: createHash('sha256').update(yaml).digest('hex'),
      checks,
      recommendationScopeRegistration: {
        operationClients,
        pendingRegistrationClients,
        notListedInPendingRegistry: operationClients.filter(
          (c) => !pendingRegistrationClients.includes(c),
        ),
        status: 'BLOCKED_G7_REGISTRATION_EVIDENCE',
        interpretation:
          'Operation allowlist and pending registration inventory differ. Preserve operation authorization; neither entry proves a real grant. Marco/G7 must reconcile and provide verifiable grants for Marketplace.',
      },
    },
    null,
    2,
  ),
);
