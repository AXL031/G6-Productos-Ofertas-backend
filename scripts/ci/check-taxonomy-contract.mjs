#!/usr/bin/env node
/**
 * Compara las operaciones de Taxonomy del OpenAPI oficial con las rutas declaradas
 * en api-gateway y las decoradas en Nest. También exige evidencias de prueba por ID.
 * Uso: node scripts/ci/check-taxonomy-contract.mjs <openapi.yaml>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const contractPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, '../docs/contratos/http/openapi.yaml');
const contractText = readFileSync(contractPath, 'utf8');
const taxPath = (path) =>
  /^\/(?:categorias|marcas|caracteristicas|tipos-producto|taxonomia|seo)(?:\/|$)/.test(
    path,
  );
const httpMethods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
]);
const operations = [];
let currentPath;
let current;
let inPaths = false;
for (const line of contractText.split(/\r?\n/)) {
  if (/^paths:\s*$/.test(line)) {
    inPaths = true;
    continue;
  }
  if (!inPaths) continue;
  const pathMatch = /^  (\/[^:]+):\s*$/.exec(line);
  if (pathMatch) {
    currentPath = pathMatch[1];
    current = undefined;
    continue;
  }
  const methodMatch = /^    (get|post|put|patch|delete|head|options):\s*$/.exec(
    line,
  );
  if (methodMatch && currentPath && taxPath(currentPath)) {
    current = {
      method: methodMatch[1].toUpperCase(),
      path: `/api/v1${currentPath}`,
    };
    operations.push(current);
    continue;
  }
  if (current) {
    const idMatch = /^      operationId:\s*([A-Za-z0-9_]+)\s*$/.exec(line);
    if (idMatch) current.operationId = idMatch[1];
  }
  if (inPaths && /^components:\s*$/.test(line)) break;
}
for (const operation of operations) {
  if (!operation.operationId)
    throw new Error(
      `OpenAPI sin operationId: ${operation.method} ${operation.path}`,
    );
}
const normalize = (path) =>
  `/${path
    .replace(/^\/+/, '')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\/+$/, '')}`;
const key = (method, path) => `${method.toUpperCase()} ${normalize(path)}`;

function stringProperty(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) &&
      item.name &&
      ((ts.isIdentifier(item.name) && item.name.text === name) ||
        (ts.isStringLiteral(item.name) && item.name.text === name)),
  );
  return property && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined;
}
function methodProperty(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) &&
      ((ts.isIdentifier(item.name) && item.name.text === name) ||
        (ts.isStringLiteral(item.name) && item.name.text === name)),
  );
  return property && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined;
}
const gatewayPath = resolve(
  root,
  'apps/api-gateway/src/routing/contract-routes.ts',
);
const gatewaySource = ts.createSourceFile(
  gatewayPath,
  readFileSync(gatewayPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const gateway = [];
function visitGateway(node) {
  if (
    ts.isObjectLiteralExpression(node) &&
    stringProperty(node, 'service') === 'taxonomy-svc'
  ) {
    const method = stringProperty(node, 'method');
    const path = stringProperty(node, 'path');
    const operationId = stringProperty(node, 'operationId');
    if (method && path && operationId)
      gateway.push({ method, path, operationId });
  }
  ts.forEachChild(node, visitGateway);
}
visitGateway(gatewaySource);

const controllersDir = resolve(root, 'apps/taxonomy-svc/src');
const runtime = [];
const routeDecorators = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Head', 'HEAD'],
  ['Options', 'OPTIONS'],
]);
const literal = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : '';
for (const file of readdirSync(controllersDir).filter((name) =>
  name.endsWith('.controller.ts'),
)) {
  const filename = join(controllersDir, file);
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    let prefix = '';
    for (const decorator of statement.modifiers?.filter(ts.isDecorator) ?? []) {
      const expression = decorator.expression;
      if (
        ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'Controller'
      )
        prefix = literal(expression.arguments[0]);
    }
    if (!prefix) continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.modifiers) continue;
      for (const decorator of member.modifiers.filter(ts.isDecorator)) {
        const expression = decorator.expression;
        if (
          !ts.isCallExpression(expression) ||
          !ts.isIdentifier(expression.expression)
        )
          continue;
        const method = routeDecorators.get(expression.expression.text);
        if (!method) continue;
        const path = literal(expression.arguments[0]);
        runtime.push({
          method,
          path: normalize(`${prefix}/${path}`),
          source: file,
        });
      }
    }
  }
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(path)
      : /\.(spec|e2e-spec)\.ts$/.test(entry.name)
        ? [path]
        : [];
  });
}
const tests = listFiles(resolve(root, 'apps/taxonomy-svc'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const idsInTests = new Set(
  [
    ...tests.matchAll(
      /(?:operationId|contract-test)\s*[:=]\s*['"]([A-Za-z0-9_]+)['"]/g,
    ),
  ].map((match) => match[1]),
);

function differences(expected, actual, label) {
  const found = new Set(actual.map((item) => key(item.method, item.path)));
  return expected
    .filter((item) => !found.has(key(item.method, item.path)))
    .map(
      (item) =>
        `${label}: falta ${item.operationId} (${item.method} ${item.path})`,
    );
}
const failures = [
  ...differences(operations, gateway, 'Gateway'),
  ...differences(operations, runtime, 'NestJS'),
  ...operations.flatMap((item) => {
    const found = gateway.find(
      (route) => key(route.method, route.path) === key(item.method, item.path),
    );
    return found && found.operationId !== item.operationId
      ? [
          `Gateway: operationId distinto en ${item.method} ${item.path} (${found.operationId} ≠ ${item.operationId})`,
        ]
      : [];
  }),
  ...operations
    .filter((item) => !idsInTests.has(item.operationId))
    .map((item) => `Pruebas: falta asociación para ${item.operationId}`),
];
const extras = (label, expected, actual) => {
  const found = new Set(expected.map((item) => key(item.method, item.path)));
  return actual
    .filter((item) => !found.has(key(item.method, item.path)))
    .map(
      (item) =>
        `${label}: ruta Taxonomy fuera del OpenAPI (${item.method} ${item.path})`,
    );
};
failures.push(...extras('Gateway', operations, gateway));
failures.push(...extras('NestJS', operations, runtime));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `PASS ${operations.length}/${operations.length} operaciones: OpenAPI ↔ Gateway ↔ NestJS ↔ pruebas (${contractPath})`,
  );
}
