// Input: JSON obtained from the immutable official OpenAPI YAML. Development tool only.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const input = process.argv[2];
if (!input) throw new Error('Pass the parsed official OpenAPI JSON path');
const doc = JSON.parse(readFileSync(input, 'utf8'));
const allowed = new Set([
  'listarPromociones',
  'listarPromocionesAdmin',
  'obtenerPromocionAdmin',
  'evaluarPromociones',
  'validarCupon',
  'obtenerRecomendaciones',
  'listarCupones',
  'obtenerCuponAdmin',
  'listarReglasRecomendacion',
  'obtenerReglaRecomendacion',
  'crearPromocion',
  'actualizarPromocion',
  'activarPromocion',
  'desactivarPromocion',
  'crearCupon',
  'actualizarCupon',
  'activarCupon',
  'desactivarCupon',
  'crearReglaRecomendacion',
  'actualizarReglaRecomendacion',
  'activarReglaRecomendacion',
  'desactivarReglaRecomendacion',
]);
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
const contracts = {};
for (const [path, methods] of Object.entries(doc.paths))
  for (const [method, op] of Object.entries(methods)) {
    if (!allowed.has(op.operationId)) continue;
    const parameters = resolve(op.parameters ?? []);
    contracts[op.operationId] = {
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
        (op.responses['200'] ?? op.responses['201']).content['application/json']
          .schema,
      ),
      errors: op['x-error-codes'],
    };
  }
if (Object.keys(contracts).length !== allowed.size)
  throw new Error('Missing official operationId');
const yaml = readFileSync(input.replace(/\.json$/, '.yaml'));
const digest = createHash('sha256').update(yaml).digest('hex');
const generatedLiteral = JSON.stringify(contracts, null, 2).replaceAll(
  '"then":',
  '[conditionalThen]:',
);
writeFileSync(
  'apps/promotions-svc/src/http/http-contract.generated.ts',
  `// Official Docs 51a5ce6e76bb0c61d93ef47416e46797bf5b9846, OpenAPI 0.6.0-rc.1.\n// Source SHA-256: ${digest}\n// Regenerate with test/generate-http-contract.mjs; no runtime contract download.\nimport type { HttpOperation } from './http-validation.js';\nconst conditionalThen = 'then' as const;\nexport const httpContracts: Readonly<Record<string, HttpOperation>> = ${generatedLiteral};\n`,
);
