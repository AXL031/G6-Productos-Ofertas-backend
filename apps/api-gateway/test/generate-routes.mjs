// Offline generation from the official OpenAPI converted to JSON by a YAML parser.
// Pass one operationId to update one route or --all to regenerate the full registry.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argument = process.argv[3];
if (!argument)
  throw new Error(
    'operationId is required, or pass --all to regenerate the full registry.',
  );
const regenerateAll = argument === '--all';
const operationId = regenerateAll ? null : argument;

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (spec.info.version !== '0.6.0-rc.2' || spec.servers[0].url !== '/api/v1') {
  throw new Error('Unexpected contract version or base path');
}
const owners = {
  productos: 'catalog-svc',
  categorias: 'taxonomy-svc',
  marcas: 'taxonomy-svc',
  caracteristicas: 'taxonomy-svc',
  'tipos-producto': 'taxonomy-svc',
  taxonomia: 'taxonomy-svc',
  seo: 'taxonomy-svc',
  precios: 'pricing-svc',
  'auditoria-precios': 'price-audit-svc',
  promociones: 'promotions-svc',
  cupones: 'promotions-svc',
  recomendaciones: 'promotions-svc',
  combos: 'combos-svc',
  inventario: 'inventory-svc',
  'carga-masiva': 'bulk-svc',
};
function dereference(value) {
  if (!value?.$ref) return value;
  if (!value.$ref.startsWith('#/')) throw new Error('External ref unsupported');
  return value.$ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node[key], spec);
}
const routes = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (
      !['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(
        method,
      )
    )
      continue;
    if (!regenerateAll && operation.operationId !== operationId) continue;
    const service = owners[path.split('/')[1]];
    if (
      !service ||
      !operation.operationId ||
      !Array.isArray(operation.security)
    ) {
      throw new Error(`Incomplete route ${method} ${path}`);
    }
    const security = operation.security.map((alternative) => {
      const schemes = Object.keys(alternative);
      if (
        schemes.length !== 1 ||
        !['serviceBearer', 'userBearer'].includes(schemes[0])
      ) {
        throw new Error('Unsupported security expression');
      }
      return schemes[0];
    });
    const parameters = [
      ...(item.parameters || []),
      ...(operation.parameters || []),
    ].map(dereference);
    const declaredErrorCodes = operation['x-error-codes'];
    if (
      !declaredErrorCodes ||
      typeof declaredErrorCodes !== 'object' ||
      Array.isArray(declaredErrorCodes)
    ) {
      throw new Error(`Missing x-error-codes for ${operation.operationId}`);
    }
    for (const [status, codes] of Object.entries(declaredErrorCodes)) {
      const rawResponse = operation.responses[status];
      if (!rawResponse || !Array.isArray(codes) || codes.length === 0) {
        throw new Error(
          `Invalid x-error-codes entry ${status} for ${operation.operationId}`,
        );
      }
      const response = dereference(rawResponse);
      if (
        !response.content?.['application/problem+json'] ||
        codes.some(
          (code) => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(code),
        ) ||
        new Set(codes).size !== codes.length
      ) {
        throw new Error(
          `Invalid x-error-codes entry ${status} for ${operation.operationId}`,
        );
      }
    }
    routes.push({
      method: method.toUpperCase(),
      path: '/api/v1' + path,
      operationId: operation.operationId,
      service,
      security,
      scope: operation['x-required-scope'],
      audience: operation['x-service-audience'],
      clients: operation['x-allowed-client-ids'],
      role: operation['x-required-role'],
      introspection: operation['x-auth-validation'] === 'introspection',
      headers: parameters
        .filter((p) => p.in === 'header')
        .map((p) => ({
          name: p.name.toLowerCase(),
          required: !!p.required,
          minLength: p.schema?.minLength,
          maxLength: p.schema?.maxLength,
        })),
      requestTypes: Object.keys(
        dereference(operation.requestBody)?.content || {},
      ),
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, raw]) => {
          const response = dereference(raw);
          const codes = declaredErrorCodes[status] ?? [];
          if (
            (status.startsWith('4') || status.startsWith('5')) &&
            response.content?.['application/problem+json'] &&
            (!Array.isArray(codes) || codes.length === 0)
          ) {
            throw new Error(
              `Missing x-error-codes entry ${status} for ${operation.operationId}`,
            );
          }
          return [
            status,
            {
              types: Object.keys(response.content || {}),
              codes,
              headers: Object.keys(response.headers || {}).map((h) =>
                h.toLowerCase(),
              ),
            },
          ];
        }),
      ),
    });
  }
}
if (new Set(routes.map((r) => r.operationId)).size !== routes.length)
  throw new Error('Duplicate operationIds');
const output = fileURLToPath(
  new URL('../src/routing/contract-routes.ts', import.meta.url),
);
if (regenerateAll) {
  if (spec.info.version !== '0.6.0-rc.2')
    throw new Error('Full regeneration requires OpenAPI 0.6.0-rc.2');
  writeFileSync(
    output,
    '// Generated from Docs OpenAPI 0.6.0-rc.2. Use an operationId argument for a focused update.\n' +
      "import type { ContractRoute } from './contract-route.js';\n" +
      'export const CONTRACT_ROUTES: readonly ContractRoute[] = ' +
      JSON.stringify(routes, null, 2) +
      ';\n',
  );
  console.log(
    `Generated ${routes.length} operations from ${Object.keys(spec.paths).length} contract paths.`,
  );
  process.exit(0);
}
if (routes.length !== 1)
  throw new Error(`Expected one operation ${operationId}; found ${routes.length}`);
const existing = readFileSync(output, 'utf8');
const replacement = routes[0];
const marker = `operationId: '${operationId}'`;
const operationPosition = existing.indexOf(marker);
if (operationPosition < 0) throw new Error(`Unknown operation ${operationId}`);
const objectStart = existing.lastIndexOf('\n  {', operationPosition) + 3;
let depth = 0;
let quote;
let escaped = false;
let objectEnd = -1;
for (let i = objectStart; i < existing.length; i++) {
  const character = existing[i];
  if (quote) {
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === quote) quote = undefined;
    continue;
  }
  if (character === "'" || character === '"') quote = character;
  else if (character === '{') depth++;
  else if (character === '}' && --depth === 0) {
    objectEnd = i + 1;
    break;
  }
}
if (objectEnd < 0) throw new Error('Could not locate existing route object');
let existingRoute = existing.slice(objectStart, objectEnd);
for (const [status, response] of Object.entries(replacement.responses)) {
  const pattern = new RegExp(
    `('${status}'\\s*:\\s*\\{[^{}]*?\\bcodes:\\s*)\\[[^\\]]*\\]`,
  );
  const declaredCodes = `[${response.codes.map((code) => `'${code}'`).join(', ')}]`;
  if (!pattern.test(existingRoute))
    throw new Error(`Could not find ${status} codes for ${operationId}`);
  existingRoute = existingRoute.replace(pattern, `$1${declaredCodes}`);
}
writeFileSync(
  output,
  `// Generated from Docs OpenAPI 0.6.0-rc.2; focused update: ${operationId}.\n` +
    existing.slice(existing.indexOf('\n') + 1, objectStart) +
    existingRoute +
    existing.slice(objectEnd),
);
console.log(`Updated ${operationId} only.`);