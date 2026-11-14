// Offline generation from the official OpenAPI converted to JSON by a YAML parser.
// For one route, pass its operationId as the third argument; its contract-derived
// security metadata and error codes are refreshed without touching other routes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const operationId = process.argv[3];
const add = process.argv[4] === '--add';
if (!operationId)
  throw new Error(
    'An operationId is required; full contract route regeneration is disabled.',
  );

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const adminCandidates = {
  '0.6.0-h4-combos-admin': {
    method: 'POST',
    service: 'combos-svc',
    path: /^\/api\/v1\/combos\/administracion$/,
  },
  '0.6.0-h4-price-audit-admin': {
    service: 'price-audit-svc',
    path: /^\/api\/v1\/auditoria-precios\/administracion(?:\/\{auditId\})?$/,
  },
  '0.6.0-h4-inventory-admin': {
    service: 'inventory-svc',
    path: /^\/api\/v1\/inventario\/administracion\/saldos$/,
  },
  '0.6.0-h4-catalog-admin': {
    service: 'catalog-svc',
    path: /^\/api\/v1\/productos\/administracion(?:\/\{productoId\})?$/,
  },
  '0.6.0-h4-pricing-admin': {
    service: 'pricing-svc',
    path: /^\/api\/v1\/precios\/administracion\/(?:productos\/\{productoId\}|skus\/\{sku\})$/,
  },
};
const candidate = adminCandidates[spec.info.version];
if (
  (add
    ? !candidate
    : !['0.6.0-rc.2', '0.6.0-rc.3'].includes(spec.info.version)) ||
  spec.servers[0].url !== '/api/v1'
) {
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
    if (operation.operationId !== operationId) continue;
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
      throw new Error(`Missing x-error-codes for ${operationId}`);
    }
    for (const [status, codes] of Object.entries(declaredErrorCodes)) {
      const rawResponse = operation.responses[status];
      if (!rawResponse || !Array.isArray(codes) || codes.length === 0) {
        throw new Error(
          `Invalid x-error-codes entry ${status} for ${operationId}`,
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
          `Invalid x-error-codes entry ${status} for ${operationId}`,
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
          if (status.startsWith('4') || status.startsWith('5')) {
            if (
              response.content?.['application/problem+json'] &&
              (!Array.isArray(codes) || codes.length === 0)
            ) {
              throw new Error(
                `Missing x-error-codes entry ${status} for ${operationId}`,
              );
            }
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
if (routes.length !== 1)
  throw new Error(
    `Expected one operation ${operationId}; found ${routes.length}`,
  );
const output = fileURLToPath(
  new URL('../src/routing/contract-routes.ts', import.meta.url),
);
const existing = readFileSync(output, 'utf8');
const replacement = routes[0];
if (add) {
  const { CONTRACT_ROUTES } = await import(pathToFileURL(output).href);
  const shape = (path) => path.replace(/\{[^}]+\}/g, '{}');
  if (
    replacement.method !== (candidate.method ?? 'GET') ||
    replacement.service !== candidate.service ||
    replacement.security.length !== 1 ||
    replacement.security[0] !== 'userBearer' ||
    replacement.role !== 'GESTOR_COMERCIAL' ||
    !candidate.path.test(replacement.path) ||
    CONTRACT_ROUTES.some(
      (route) =>
        route.operationId === operationId ||
        (route.method === replacement.method &&
          shape(route.path) === shape(replacement.path)),
    )
  )
    throw new Error(`Cannot add candidate operation ${operationId}`);
  const end = existing.lastIndexOf('\n];');
  if (end < 0) throw new Error('Could not locate route registry terminator');
  writeFileSync(
    output,
    existing.slice(0, end) +
      '\n' +
      JSON.stringify(replacement, null, 2)
        .split('\n')
        .map((line) => '  ' + line)
        .join('\n') +
      ',' +
      existing.slice(end),
  );
  console.log(`Added ${operationId} from candidate OpenAPI.`);
  process.exit(0);
}
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
const generatedSecurity = `security: [${replacement.security.map((scheme) => `'${scheme}'`).join(', ')}]`;
existingRoute = existingRoute.replace(
  /security: \[[^\]]*\]/,
  generatedSecurity,
);
for (const [name, value] of [
  ['scope', replacement.scope],
  ['audience', replacement.audience],
  ['clients', replacement.clients],
]) {
  const serialized =
    value === undefined
      ? undefined
      : Array.isArray(value)
        ? `[${value.map((item) => `'${item}'`).join(', ')}]`
        : `'${value}'`;
  const property = new RegExp(`\\b${name}:\\s*(?:'[^']*'|\\[[^\\]]*\\]),?`);
  if (serialized === undefined) {
    existingRoute = existingRoute
      .replace(property, '')
      .replace(/\n\s*\n/g, '\n');
  } else if (property.test(existingRoute)) {
    existingRoute = existingRoute.replace(property, `${name}: ${serialized},`);
  } else {
    existingRoute = existingRoute.replace(
      /service: '[^']+',/,
      (service) => `${service}\n    ${name}: ${serialized},`,
    );
  }
}
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
  `// Generated from Docs OpenAPI ${spec.info.version}; focused update: ${operationId}.\n` +
    existing.slice(existing.indexOf('\n') + 1, objectStart) +
    existingRoute +
    existing.slice(objectEnd),
);
console.log(`Updated ${operationId} only.`);
