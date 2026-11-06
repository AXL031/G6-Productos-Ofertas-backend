import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('focused Gateway contract route generation', () => {
  const operationId = 'verificarCantidadComercial';
  const errorCodes: Record<string, string[]> = {
    '400': ['VALIDACION'],
    '401': ['TOKEN_INVALIDO'],
    '403': ['SCOPE_INSUFICIENTE'],
    '422': ['CONTEXTO_ABASTECIMIENTO_INVALIDO'],
    '429': ['RATE_LIMIT_EXCEDIDO'],
    '500': ['ERROR_INTERNO'],
    '503': ['SERVICIO_NO_DISPONIBLE'],
  };
  let root: string;
  let scriptPath: string;
  let specPath: string;
  let routesPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gateway-route-generator-'));
    const testDirectory = join(root, 'apps', 'api-gateway', 'test');
    const sourceDirectory = join(root, 'apps', 'api-gateway', 'src', 'routing');
    mkdirSync(testDirectory, { recursive: true });
    mkdirSync(sourceDirectory, { recursive: true });
    scriptPath = join(testDirectory, 'generate-routes.mjs');
    specPath = join(root, 'openapi-0.6.0-rc.2.json');
    routesPath = join(sourceDirectory, 'contract-routes.ts');
    writeFileSync(
      scriptPath,
      readFileSync(
        fileURLToPath(new URL('./generate-routes.mjs', import.meta.url)),
        'utf8',
      ),
    );

    const responses = {
      '200': {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      ...Object.fromEntries(
        Object.entries(errorCodes).map(([status]) => [
          status,
          {
            content: {
              'application/problem+json': { schema: { type: 'object' } },
            },
          },
        ]),
      ),
    };
    writeFileSync(
      specPath,
      JSON.stringify({
        info: { version: '0.6.0-rc.3' },
        servers: [{ url: '/api/v1' }],
        paths: {
          '/inventario/disponibilidad/comercial/verificar': {
            post: {
              operationId,
              security: [{ serviceBearer: [] }],
              'x-required-scope': 'catalogo:leer',
              'x-service-audience': 'api-productos',
              'x-allowed-client-ids': ['modulo-productos'],
              parameters: [],
              responses,
              'x-error-codes': errorCodes,
            },
          },
        },
      }),
    );
    writeFileSync(
      routesPath,
      `// fixture header\nimport type { ContractRoute } from './contract-route.js';\nexport const CONTRACT_ROUTES: readonly ContractRoute[] = [\n` +
        `  {\n    method: 'GET',\n    path: '/api/v1/productos',\n    operationId: 'listarProductos',\n    responses: { '200': { codes: [] } },\n  },\n` +
        `  {\n    method: 'POST',\n    path: '/api/v1/inventario/disponibilidad/comercial/verificar',\n    operationId: '${operationId}',\n    service: 'inventory-svc',\n    security: ['userBearer'],\n    scope: 'precios:leer',\n    audience: 'api-productos',\n    clients: ['modulo-ventas'],\n    responses: {\n` +
        `      '200': { codes: [] },\n` +
        Object.keys(errorCodes)
          .map((status) => `      '${status}': { codes: [] },\n`)
          .join('') +
        `    },\n  },\n];\n`,
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function runGenerator(targetOperationId?: string) {
    return spawnSync(
      process.execPath,
      [scriptPath, specPath, ...(targetOperationId ? [targetOperationId] : [])],
      { encoding: 'utf8' },
    );
  }

  it('fails closed without an operationId and leaves the registry untouched', () => {
    const before = readFileSync(routesPath, 'utf8');
    const result = runGenerator();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('operationId is required');
    expect(readFileSync(routesPath, 'utf8')).toBe(before);
  });

  it('rejects malformed x-error-codes without writing the registry', () => {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    spec.paths['/inventario/disponibilidad/comercial/verificar'].post[
      'x-error-codes'
    ]['422'] = [42];
    writeFileSync(specPath, JSON.stringify(spec));
    const before = readFileSync(routesPath, 'utf8');
    const result = runGenerator(operationId);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid x-error-codes entry 422');
    expect(readFileSync(routesPath, 'utf8')).toBe(before);
  });

  it('updates only the selected operation and is byte-idempotent on rerun', () => {
    const before = readFileSync(routesPath, 'utf8');
    const otherOperation = before.match(
      /  \{[\s\S]*?operationId: 'listarProductos',[\s\S]*?\n  \},/,
    )?.[0];
    expect(otherOperation).toBeDefined();

    const firstRun = runGenerator(operationId);
    expect(firstRun.status).toBe(0);
    const afterFirstRun = readFileSync(routesPath, 'utf8');
    const otherOperationAfter = afterFirstRun.match(
      /  \{[\s\S]*?operationId: 'listarProductos',[\s\S]*?\n  \},/,
    )?.[0];
    expect(otherOperationAfter).toBe(otherOperation);
    expect(afterFirstRun).toContain(
      '// Generated from Docs OpenAPI 0.6.0-rc.3; focused update: verificarCantidadComercial.',
    );
    expect(afterFirstRun).toContain("'400': { codes: ['VALIDACION'] }");
    expect(afterFirstRun).toContain("security: ['serviceBearer']");
    expect(afterFirstRun).toContain("scope: 'catalogo:leer'");
    expect(afterFirstRun).toContain("clients: ['modulo-productos']");
    expect(afterFirstRun).toContain(
      "'422': { codes: ['CONTEXTO_ABASTECIMIENTO_INVALIDO'] }",
    );

    const secondRun = runGenerator(operationId);
    expect(secondRun.status).toBe(0);
    expect(readFileSync(routesPath, 'utf8')).toBe(afterFirstRun);
  });
});
