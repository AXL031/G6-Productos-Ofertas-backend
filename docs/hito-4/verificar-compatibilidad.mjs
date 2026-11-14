import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTRACT_ROUTES } from '../../apps/api-gateway/src/routing/contract-routes.ts';
import { PHASE1_INTERNAL_READ_ROUTES } from '../../apps/api-gateway/src/routing/phase1-internal-read-routes.ts';

const read = (name) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const baseline = read('baseline-contratos.json');
const proposedPaths = {
  ...read('catalogo-admin.openapi.json').paths,
  ...read('pricing-admin.openapi.json').paths,
  ...read('inventory-admin.openapi.json').paths,
  ...read('price-audit-admin.openapi.json').paths,
  ...read('combos-admin.openapi.json').paths,
};
const legacyIds = new Set(baseline.gateway.map((route) => route.operationId));

assert.deepEqual(
  CONTRACT_ROUTES.filter((route) => legacyIds.has(route.operationId)),
  baseline.gateway,
);
assert.deepEqual(PHASE1_INTERNAL_READ_ROUTES, baseline.gatewayPhase1Internal);
const additions = CONTRACT_ROUTES.filter(
  (route) => !legacyIds.has(route.operationId),
);
assert.deepEqual(
  additions.map((route) => route.operationId),
  Object.values(proposedPaths).flatMap((item) =>
    Object.values(item).map((operation) => operation.operationId),
  ),
);
for (const route of additions) {
  const path = route.path.slice('/api/v1'.length);
  const operation = proposedPaths[path][route.method.toLowerCase()];
  assert.ok(operation);
  const owners = {
    productos: 'catalog-svc',
    precios: 'pricing-svc',
    inventario: 'inventory-svc',
    'auditoria-precios': 'price-audit-svc',
    combos: 'combos-svc',
  };
  assert.equal(route.service, owners[path.split('/')[1]]);
  assert.equal(route.role, operation['x-required-role']);
  assert.deepEqual(route.security, ['userBearer']);
  assert.deepEqual(
    Object.keys(route.responses),
    Object.keys(operation.responses),
  );
  for (const [status, response] of Object.entries(route.responses)) {
    assert.deepEqual(response.codes, operation['x-error-codes'][status] ?? []);
    assert.deepEqual(
      response.types,
      Object.keys(operation.responses[status].content),
    );
  }
}

const http = Object.values(baseline.http.contract.paths).flatMap((item) =>
  Object.values(item).filter((operation) => operation?.operationId),
);
console.log(
  JSON.stringify(
    {
      backendBase: baseline.backendCommit,
      docsBase: baseline.docsCommit,
      openApiOperations: http.length,
      outsideMainGatewayRegistry: http
        .filter((operation) => !legacyIds.has(operation.operationId))
        .map((operation) => operation.operationId),
      legacyGatewayUnchanged: legacyIds.size,
      phase1InternalRoutesUnchanged: PHASE1_INTERNAL_READ_ROUTES.length,
      gatewayAdditions: additions,
      asyncApiChannels: Object.keys(baseline.events.contract.channels).length,
    },
    null,
    2,
  ),
);
