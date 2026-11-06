import { createServer, type Server } from 'node:http';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { Phase1Postgres } from './support/phase1-postgres.js';
import { createSignedIdentity } from './support/signed-identity.js';

const enabled = process.env.G6_INVENTORY_GATEWAY_POSTGRES_E2E === '1';
const run = enabled ? describe : describe.skip;
const issuer = 'https://isolated.test/issuer';
const commercial = '/api/v1/inventario/disponibilidad/comercial';
const verify = `${commercial}/verificar`;
const locationId = 'a1ed4218-6d13-4df0-ae43-3379c1e7f932';
const enoughSku = 'GATEWAY-E2E-ENOUGH';
const shortSku = 'GATEWAY-E2E-SHORT';
const missingSku = 'GATEWAY-E2E-MISSING';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No se obtuvo un puerto local para Inventory');
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function waitForInventory(
  child: ChildProcess,
  origin: string,
): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error('Inventory compilado terminó antes de readiness');
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // El proceso aún puede estar enlazando PostgreSQL o escuchando HTTP.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Inventory compilado no alcanzó /health en 30 segundos');
}

async function stop(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  let forceTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolveDelay) => {
        forceTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolveDelay();
        }, 5000);
      }),
    ]);
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
  }
}

run('Gateway → Inventory HTTP real → PostgreSQL 17 (JWT RS256 fixture)', () => {
  let postgres: Phase1Postgres;
  let inventory: ChildProcess | undefined;
  let app: INestApplication | undefined;
  let jwks: Server | undefined;
  let inventoryOrigin: string;
  let gateway: string;
  let signed: ReturnType<typeof createSignedIdentity>;
  let settings: GatewaySettings;
  let inventoryEnvironment: NodeJS.ProcessEnv;

  const token = (sub: string, scope = 'inventario:disponibilidad:leer') =>
    signed.token({
      iss: issuer,
      sub,
      tipo: 'servicio',
      aud: ['api-productos'],
      scope,
    });

  const input = (sku: string, quantity = 2) => ({
    channel_id: 'MARKETPLACE',
    fulfillment: { mode: 'ENVIO_DOMICILIO', fulfillment_ref: 'E2E-LIMA' },
    lines: [{ sku, quantity }],
  });

  async function startGateway(): Promise<void> {
    jwks = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [signed.key] }));
    });
    jwks.listen(0, '127.0.0.1');
    await once(jwks, 'listening');
    const jwksAddress = jwks.address();
    if (!jwksAddress || typeof jwksAddress === 'string')
      throw new Error('No se obtuvo el puerto local JWKS');

    settings = {
      upstreams: { 'inventory-svc': inventoryOrigin },
      timeoutMs: 5000,
      maxBytes: 10 * 1024 * 1024,
      issuer,
      jwksUrl: `http://127.0.0.1:${jwksAddress.port}/.well-known/jwks.json`,
      publicOperations: [],
      demoNoAuthEnabled: false,
      readOnlyDemoEnabled: false,
      securityMode: 'G7_AUTHENTICATED',
    };
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .compile();
    app = module.createNestApplication({ bodyParser: false, logger: false });
    await app.listen(0, '127.0.0.1');
    gateway = await app.getUrl();
  }

  async function cleanup(): Promise<void> {
    await app?.close();
    app = undefined;
    await stop(inventory);
    inventory = undefined;
    if (jwks?.listening)
      await new Promise<void>((resolveClose, reject) =>
        jwks!.close((error) => (error ? reject(error) : resolveClose())),
      );
    jwks = undefined;
    await postgres?.close();
  }

  async function startInventory(): Promise<void> {
    const mapping = execFileSync(
      'docker',
      ['port', postgres.name, '5432/tcp'],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    const mappedPort = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    if (!mappedPort)
      throw new Error('PostgreSQL debe permanecer publicado solo en loopback');
    postgres.port = mappedPort;
    inventoryEnvironment.DATABASE_URL = `postgresql://inventory_gateway_e2e:${encodeURIComponent(postgres.password)}@127.0.0.1:${postgres.port}/postgres?sslmode=disable`;
    inventory = spawn(process.execPath, ['dist/apps/inventory-svc/main.js'], {
      cwd: process.cwd(),
      env: inventoryEnvironment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    inventory.stdout?.resume();
    inventory.stderr?.resume();
    await waitForInventory(inventory, inventoryOrigin);
  }

  beforeAll(async () => {
    try {
      const testSettings: GatewaySettings = {
        upstreams: {},
        timeoutMs: 5000,
        maxBytes: 10 * 1024 * 1024,
        issuer,
        jwksUrl: '',
        publicOperations: [],
        demoNoAuthEnabled: false,
        readOnlyDemoEnabled: false,
        securityMode: 'G7_AUTHENTICATED',
      };
      signed = createSignedIdentity(testSettings);
      postgres = new Phase1Postgres();
      await postgres.start();
      const postgresVersion = postgres.sql('SHOW server_version_num;');
      if (!postgresVersion.startsWith('17'))
        throw new Error(
          `El harness requiere PostgreSQL 17; obtuvo ${postgresVersion}`,
        );
      console.info(
        `[inventory-gateway-e2e] SHA=${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()} PostgreSQL=${postgresVersion} JWT=RS256-fixture AUTHENTICATED bypasses=false`,
      );

      const docsRoot = resolve(process.env.G6_DOCS_ROOT ?? '../docs');
      const baseMigration = readFileSync(
        resolve(docsRoot, 'datos/inventory-svc/migration.sql'),
        'utf8',
      );
      const incrementalMigration = readFileSync(
        resolve(
          docsRoot,
          'datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql',
        ),
        'utf8',
      );
      const lifecycleMigration = readFileSync(
        resolve(
          process.cwd(),
          'apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql',
        ),
        'utf8',
      );
      postgres.sql(baseMigration);
      postgres.sql(`BEGIN;\n${incrementalMigration}\nCOMMIT;`);
      postgres.sql(lifecycleMigration);
      postgres.sql(`
      CREATE ROLE inventory_gateway_e2e LOGIN PASSWORD '${postgres.password}';
      GRANT USAGE ON SCHEMA inventory TO inventory_gateway_e2e;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA inventory TO inventory_gateway_e2e;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA inventory TO inventory_gateway_e2e;
      INSERT INTO inventory.locations (id, code, name, type, active)
      VALUES ('${locationId}', 'GATEWAY-E2E-LIMA', 'Gateway E2E Lima', 'ALMACEN', true);
      INSERT INTO inventory.commercial_fulfillment_routes
        (channel_id, mode, fulfillment_ref, location_id, active)
      VALUES ('MARKETPLACE', 'ENVIO_DOMICILIO', 'E2E-LIMA', '${locationId}', true);
      INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand, reserved, blocked)
      VALUES ('${enoughSku}', '${locationId}', 14, 1, 1),
             ('${shortSku}', '${locationId}', 1, 0, 0);
    `);

      const inventoryPort = await unusedPort();
      inventoryOrigin = `http://127.0.0.1:${inventoryPort}`;
      inventoryEnvironment = {
        ...process.env,
        NODE_ENV: 'test',
        INVENTORY_SVC_PORT: String(inventoryPort),
        DATABASE_URL: `postgresql://inventory_gateway_e2e:${encodeURIComponent(postgres.password)}@127.0.0.1:${postgres.port}/postgres?sslmode=disable`,
        INVENTORY_DEMO_NO_AUTH_ENABLED: 'false',
        G6_READ_ONLY_DEMO_ENABLED: 'false',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'false',
        G7_JWT_ISSUER: issuer,
        G7_JWT_PUBLIC_KEY: signed.publicKeyPem,
        JWT_PUBLIC_KEY: signed.publicKeyPem,
        INVENTORY_WORKER_INTERVAL_MS: '60000',
      };
      delete inventoryEnvironment.RABBITMQ_URL;
      await startInventory();

      await startGateway();
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 120000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  async function snapshot(): Promise<string> {
    return postgres.sql(`
      SELECT jsonb_build_object(
        'balances', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY sku_id), '[]'::jsonb)
                     FROM inventory.stock_balance b WHERE sku_id LIKE 'GATEWAY-E2E-%'),
        'reservations', (SELECT count(*) FROM inventory.reservations),
        'operations', (SELECT count(*) FROM inventory.inventory_operations),
        'kardex', (SELECT count(*) FROM inventory.kardex)
      )::text;
    `);
  }

  it('usa el mismo JWT RS256 fixture en Gateway e Inventory y consulta GET comercial', async () => {
    expect(settings.demoNoAuthEnabled).toBe(false);
    expect(settings.readOnlyDemoEnabled).toBe(false);
    const correlationId = randomUUID();
    const response = await request(gateway)
      .get(`${commercial}?skus=${enoughSku}&canal=MARKETPLACE`)
      .set('Authorization', `Bearer ${token('modulo-productos')}`)
      .set('X-Correlation-Id', correlationId)
      .expect(200);
    expect(response.body).toEqual({
      items: [{ sku: enoughSku, status: 'DISPONIBLE' }],
    });
    expect(response.headers['x-correlation-id']).toBe(correlationId);
  });

  it('POST autenticado devuelve los tres resultados comerciales sin alterar estado', async () => {
    const before = await snapshot();
    for (const [sku, quantity, result] of [
      [enoughSku, 2, 'SUFICIENTE'],
      [shortSku, 2, 'INSUFICIENTE'],
      [missingSku, 2, 'INDETERMINADO'],
    ] as const) {
      const correlationId = randomUUID();
      const response = await request(gateway)
        .post(verify)
        .set('Authorization', `Bearer ${token('modulo-marketplace')}`)
        .set('X-Correlation-Id', correlationId)
        .send(input(sku, quantity))
        .expect(200);
      expect(response.body.binding).toBe(false);
      expect(response.body.items[0].result).toBe(result);
      expect(response.headers['x-correlation-id']).toBe(correlationId);
    }
    expect(await snapshot()).toBe(before);
  });

  it('rechaza POST para modulo-productos y JWT ausente/malformado/firma inválida/cliente o scope erróneo antes del upstream', async () => {
    const upstreams = settings.upstreams;
    Object.assign(settings, { upstreams: {} });
    try {
      await request(gateway).get(commercial).expect(401);
      await request(gateway)
        .get(commercial)
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);

      const valid = token('modulo-productos');
      const parts = valid.split('.');
      const badSignature = `${parts[0]}.${parts[1]}.${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
      await request(gateway)
        .get(commercial)
        .set('Authorization', `Bearer ${badSignature}`)
        .expect(401);

      for (const [identity, scope, status] of [
        ['cliente-no-autorizado', 'inventario:disponibilidad:leer', 403],
        ['modulo-productos', 'inventario:reservar', 403],
      ] as const) {
        await request(gateway)
          .get(commercial)
          .set('Authorization', `Bearer ${token(identity, scope)}`)
          .expect(status);
      }
      await request(gateway)
        .post(verify)
        .set('Authorization', `Bearer ${token('modulo-productos')}`)
        .send(input(enoughSku))
        .expect(403);
    } finally {
      Object.assign(settings, { upstreams });
    }

    for (const [sub, canal] of [
      ['modulo-marketplace', 'RETAIL'],
      ['modulo-productos', 'CHATBOT'],
    ] as const) {
      const response = await request(gateway)
        .get(`${commercial}?skus=${enoughSku}&canal=${canal}`)
        .set('Authorization', `Bearer ${token(sub)}`)
        .expect(403);
      expect(response.body.code).toBe('SCOPE_INSUFICIENTE');
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
    }
  });

  it('propaga 400 y 422 Problem Details desde Inventory y conserva correlación/sanitización', async () => {
    const invalidCorrelation = randomUUID();
    const invalid = await request(gateway)
      .post(verify)
      .set('Authorization', `Bearer ${token('modulo-marketplace')}`)
      .set('X-Correlation-Id', invalidCorrelation)
      .send(input(enoughSku, 0))
      .expect(400);
    expect(invalid.body.code).toBe('VALIDACION');
    expect(invalid.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(invalid.headers['x-correlation-id']).toBe(invalidCorrelation);
    expect(invalid.body.correlationId).toBe(invalidCorrelation);
    expect(invalid.text).not.toMatch(
      /postgres|inventory_gateway_e2e|PGPASSWORD/i,
    );

    const invalidContext = await request(gateway)
      .post(verify)
      .set('Authorization', `Bearer ${token('modulo-marketplace')}`)
      .set('X-Correlation-Id', randomUUID())
      .send({ ...input(enoughSku), fulfillment: { mode: 'CONTEXTO_INVALIDO' } })
      .expect(422);
    expect(invalidContext.body.code).toBe('CONTEXTO_ABASTECIMIENTO_INVALIDO');
    expect(invalidContext.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(invalidContext.body.correlationId).toBeTruthy();
    expect(invalidContext.text).not.toMatch(
      /postgres|inventory_gateway_e2e|PGPASSWORD/i,
    );
  });

  it('sanitiza un error PostgreSQL real como ERROR_INTERNO sin exponer el esquema', async () => {
    postgres.sql(
      'REVOKE SELECT ON inventory.stock_balance FROM inventory_gateway_e2e;',
    );
    try {
      const response = await request(gateway)
        .post(verify)
        .set('Authorization', `Bearer ${token('modulo-marketplace')}`)
        .send(input(enoughSku))
        .expect(500);
      expect(response.body.code).toBe('ERROR_INTERNO');
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.text).not.toMatch(
        /permission denied|stock_balance|inventory_gateway_e2e|postgres/i,
      );
    } finally {
      postgres.sql(
        'GRANT SELECT ON inventory.stock_balance TO inventory_gateway_e2e;',
      );
    }
  });

  it('caracteriza la respuesta real de Inventory ante caída PostgreSQL y recupera el servicio', async () => {
    execFileSync('docker', ['stop', postgres.name], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    try {
      // Caracterización temporal: Taco debe cambiar ambos expects a 503
      // SERVICIO_NO_DISPONIBLE cuando Inventory corrija la clasificación.
      const providerResponse = await request(inventoryOrigin)
        .get(`${commercial}?skus=${enoughSku}&canal=MARKETPLACE`)
        .set('Authorization', `Bearer ${token('modulo-productos')}`)
        .expect(500);
      expect(providerResponse.body.code).toBe('ERROR_INTERNO');
      const response = await request(gateway)
        .get(`${commercial}?skus=${enoughSku}&canal=MARKETPLACE`)
        .set('Authorization', `Bearer ${token('modulo-productos')}`)
        .expect(500);
      expect(response.body.code).toBe('ERROR_INTERNO');
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.text).not.toMatch(
        /ECONNREFUSED|127\.0\.0\.1|inventory_gateway_e2e|postgresql:\/\//i,
      );
      console.warn(
        '[inventory-gateway-e2e] DEFECT INVENTORY: caída real de PostgreSQL devolvió 500/ERROR_INTERNO; se esperaba 503/SERVICIO_NO_DISPONIBLE.',
      );
    } finally {
      execFileSync('docker', ['start', postgres.name], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
    }
    const deadline = Date.now() + 30000;
    for (;;) {
      const probe = spawnSync(
        'docker',
        ['exec', postgres.name, 'pg_isready', '-U', 'postgres'],
        { windowsHide: true, timeout: 3000, stdio: 'ignore' },
      );
      if (probe.status === 0) break;
      if (Date.now() >= deadline)
        throw new Error('PostgreSQL no se recuperó en 30 segundos');
      await delay(200);
    }
    await stop(inventory);
    await startInventory();
    await request(gateway)
      .get(`${commercial}?skus=${enoughSku}&canal=MARKETPLACE`)
      .set('Authorization', `Bearer ${token('modulo-productos')}`)
      .expect(200);
  }, 30000);

  it('responde 503 Problem Details cuando Inventory HTTP deja de estar disponible', async () => {
    await stop(inventory);
    const response = await request(gateway)
      .get(`${commercial}?skus=${enoughSku}&canal=MARKETPLACE`)
      .set('Authorization', `Bearer ${token('modulo-productos')}`)
      .expect(503);
    expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.text).not.toMatch(
      /ECONNREFUSED|127\.0\.0\.1|inventory_gateway_e2e/i,
    );
  });
});
