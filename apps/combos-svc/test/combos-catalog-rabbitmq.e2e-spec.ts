import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import amqp, { type ChannelModel } from 'amqplib';
import type { Channel } from 'amqplib';
import { vi } from 'vitest';
import { CombosDatabase } from '../src/persistence/combos.database.js';
import { CombosRepository } from '../src/persistence/combos.repository.js';
import { CombosEventConsumer } from '../src/messaging/combos-event-consumer.js';
import {
  CatalogSkuContextClient,
  IntegrationFailure,
} from '../src/integrations/catalog-sku-context.client.js';
import { CombosSvcService } from '../src/combos-svc.service.js';

const exchange = 'po.eventos.x';
const queue = 'po.combos.q';
const routes = [
  'catalog.product.deactivated',
  'catalog.sku.deactivated',
  'inventory.stock.changed',
];
const activeProductId = '30000000-0000-4000-8000-000000000001';
const inactiveProductId = '30000000-0000-4000-8000-000000000002';
const variantProductId = '30000000-0000-4000-8000-000000000003';
const activeSku = 'SKU-CATALOG-ACTIVE-001';
const inactiveSku = 'SKU-CATALOG-INACTIVE-001';
const ineligibleBaseSku = 'SKU-CATALOG-INELIGIBLE-BASE';
const opaqueSku = 'SKU /?%# ñ';
const execPath = resolve(process.cwd(), 'dist/apps/catalog-svc/main.js');

describe('Combos isolated E2E fixture preflight', () => {
  it('receives the runner-owned database, broker and Catalog credentials', () => {
    expect(process.env.COMBOS_TEST_EPHEMERAL).toBe('1');
    expect(process.env.COMBOS_TEST_DATABASE_URL).toBe('harness-owned');
    expect(process.env.COMBOS_TEST_RABBITMQ_URL?.startsWith('amqp://')).toBe(
      true,
    );
    expect(process.env.COMBOS_TEST_CATALOG_PASSWORD).toBeTruthy();
    expect(process.env.PGSSLROOTCERT).toBeTruthy();
  });
});

describe('Combos -> real Catalog + PostgreSQL 17/TLS + RabbitMQ isolated integration', () => {
  const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongSigningKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...signingKey.publicKey.export({ format: 'jwk' }),
    kid: 'combos-local-catalog-fixture',
    alg: 'RS256',
    use: 'sig',
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  let issuer = '';
  let catalogOrigin: string;
  let jwksServer: Server;
  let catalogProcess: ChildProcess;
  let catalogOutput: string[] = [];
  let publisherConnection: ChannelModel;
  let publisher: Channel;
  let consumer: CombosEventConsumer;
  let database: CombosDatabase;
  let repository: CombosRepository;
  let admin: pg.Pool;
  let comboId: string;
  let comboItemIds: Map<string, string>;
  const originalEnv: Record<string, string | undefined> = {};
  const environmentKeys = [
    'COMBOS_AMQP_ENABLED',
    'COMBOS_AMQP_URL',
    'COMBOS_CATALOG_URL',
    'COMBOS_CATALOG_SERVICE_BEARER',
    'SECURITY_ISSUER',
    'SECURITY_DISCOVERY_URL',
    'SECURITY_JWKS_URL',
  ];

  const makeToken = (
    claims: Record<string, unknown> = {},
    privateKey = signingKey.privateKey,
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      encode({ alg: 'RS256', kid: jwk.kid }) +
      '.' +
      encode({
        iss: issuer,
        sub: 'modulo-productos',
        tipo: 'servicio',
        aud: ['api-productos'],
        scope: 'catalogo:leer',
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...claims,
      });
    return (
      unsigned +
      '.' +
      sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString(
        'base64url',
      )
    );
  };

  const contextUrl = (sku: string) =>
    `${catalogOrigin}/api/v1/productos/skus/${encodeURIComponent(sku)}/contexto`;

  async function listen(server: Server): Promise<string> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('FIXTURE_ADDRESS_UNAVAILABLE');
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  }

  async function freePort(): Promise<number> {
    const server = createServer();
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('FIXTURE_ADDRESS_UNAVAILABLE');
    const port = (address as AddressInfo).port;
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
    return port;
  }

  async function seedProduct(input: {
    id: string;
    sku: string;
    state: 'ACTIVO' | 'INACTIVO';
    hasVariants?: boolean;
  }): Promise<void> {
    await admin.query(
      `INSERT INTO catalog.products
          (id, nombre, descripcion, categoria_id, tipo_producto_id, marca_id,
           sku_base, slug, tiene_variantes, estado)
         VALUES ($1, 'Fixture producto', 'Fixture de integración real',
           'categoria-fixture', 'tipo-fixture', 'marca-fixture', $2,
           $3, $4, $5::catalog.estado_producto)`,
      [
        input.id,
        input.sku,
        `fixture-${input.id}`,
        input.hasVariants ?? false,
        input.state,
      ],
    );
  }

  async function seedActivationCheck(input: {
    productId: string;
    sku: string;
    dependency: 'PRICING' | 'INVENTORY';
    variantId?: string;
  }): Promise<void> {
    await admin.query(
      `INSERT INTO catalog.activation_checks
          (product_id, variant_id, sku, dependency, operation_id, correlation_id,
           request_payload, state, result_payload, result_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'COMPLETED',
           '{}'::jsonb, $7)`,
      [
        input.productId,
        input.variantId ?? null,
        input.sku,
        input.dependency,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
  }

  async function seedCatalogFixtures(): Promise<void> {
    await admin.query('BEGIN');
    try {
      await seedProduct({
        id: activeProductId,
        sku: activeSku,
        state: 'ACTIVO',
      });
      await admin.query(
        `INSERT INTO catalog.product_images(product_id, url)
           VALUES ($1, 'https://fixture.invalid/catalog-active.png')`,
        [activeProductId],
      );
      await seedActivationCheck({
        productId: activeProductId,
        sku: activeSku,
        dependency: 'PRICING',
      });
      await seedActivationCheck({
        productId: activeProductId,
        sku: activeSku,
        dependency: 'INVENTORY',
      });
      await admin.query(
        `INSERT INTO catalog.sku_physical_profiles
             (sku_identity_id, peso_kg, largo_cm, ancho_cm, alto_cm)
           SELECT id, 1, 10, 10, 10 FROM catalog.sku_identity WHERE sku = $1`,
        [activeSku],
      );

      await seedProduct({
        id: inactiveProductId,
        sku: inactiveSku,
        state: 'INACTIVO',
      });

      await seedProduct({
        id: variantProductId,
        sku: ineligibleBaseSku,
        state: 'ACTIVO',
        hasVariants: true,
      });
      await admin.query(
        `INSERT INTO catalog.product_images(product_id, url)
           VALUES ($1, 'https://fixture.invalid/catalog-variants.png')`,
        [variantProductId],
      );
      await seedActivationCheck({
        productId: variantProductId,
        sku: ineligibleBaseSku,
        dependency: 'PRICING',
      });
      const variantId = randomUUID();
      await admin.query(
        `INSERT INTO catalog.variants
            (id, product_id, sku, identifying_key, estado)
           VALUES ($1, $2, $3, '{"color":{"valor_id":"fixture-blue"}}', 'ACTIVA')`,
        [variantId, variantProductId, opaqueSku],
      );
      await admin.query(
        `INSERT INTO catalog.variant_images(variant_id, url)
           VALUES ($1, 'https://fixture.invalid/catalog-variant.png')`,
        [variantId],
      );
      await admin.query(
        `INSERT INTO catalog.variant_attribute_values
            (variant_id, caracteristica_id, nombre_snapshot, valor_id, valor,
             es_identificador)
           VALUES ($1, 'color', 'Color', 'fixture-blue', '{}'::jsonb, true)`,
        [variantId],
      );
      await seedActivationCheck({
        productId: variantProductId,
        sku: opaqueSku,
        dependency: 'INVENTORY',
        variantId,
      });
      await admin.query(
        `INSERT INTO catalog.sku_physical_profiles
             (sku_identity_id, peso_kg, largo_cm, ancho_cm, alto_cm)
           SELECT id, 1, 10, 10, 10 FROM catalog.sku_identity WHERE sku = $1`,
        [opaqueSku],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async function waitForCatalog(token: string): Promise<void> {
    const deadline = Date.now() + 15000;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      if (catalogProcess.exitCode !== null)
        throw new Error(
          `CATALOG_EXITED:${catalogProcess.exitCode}:${catalogOutput.slice(-30).join('\n')}`,
        );
      try {
        const response = await fetch(contextUrl(activeSku), {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        });
        lastStatus = response.status;
        if (response.status === 200) return;
      } catch {
        // Process is still binding its loopback port or connecting to PostgreSQL.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(
      `CATALOG_START_TIMEOUT:${lastStatus}:${catalogOutput.slice(-30).join('\n')}`,
    );
  }

  async function publishEvent(
    name: string,
    data: Record<string, unknown>,
    messageId = randomUUID(),
    correlationId = randomUUID(),
  ) {
    const envelope = {
      message_id: messageId,
      schema_version: name === 'inventory.stock.changed' ? 2 : 1,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: null,
      operation_id: null,
      producer: name.startsWith('catalog.') ? 'catalog-svc' : 'inventory-svc',
      kind: 'event',
      name,
      data,
    };
    publisher.publish(
      exchange,
      envelope.name,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: 'application/json',
        type: envelope.name,
        messageId,
        correlationId,
      },
    );
    return messageId;
  }

  async function publishProductDeactivation(
    messageId = randomUUID(),
    correlationId = randomUUID(),
  ) {
    return publishEvent(
      'catalog.product.deactivated',
      {
        product_id: activeProductId,
        product_version: 2,
        changed_at: new Date().toISOString(),
      },
      messageId,
      correlationId,
    );
  }

  async function waitForInbox(
    messageId: string,
    handler = 'combos.catalog.product.deactivated',
    timeoutMs = 8000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await database.query((client) =>
        client.query(
          'SELECT result FROM combos.inbox WHERE message_id = $1 AND handler = $2',
          [messageId, handler],
        ),
      );
      if (result.rows[0]) return String(result.rows[0].result);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    return null;
  }

  beforeAll(async () => {
    if (
      process.env.COMBOS_TEST_EPHEMERAL !== '1' ||
      process.env.COMBOS_TEST_DATABASE_URL !== 'harness-owned'
    )
      throw new Error('COMBOS_CATALOG_HARNESS_REQUIRED');
    if (
      !process.env.COMBOS_TEST_RABBITMQ_URL?.startsWith('amqp://') ||
      !process.env.COMBOS_TEST_CATALOG_PASSWORD
    )
      throw new Error('COMBOS_CATALOG_RABBITMQ_FIXTURES_REQUIRED');
    if (!process.env.COMBOS_TEST_CATALOG_PASSWORD)
      throw new Error('CATALOG_TEST_ROLE_PASSWORD_REQUIRED');
    if (
      !readFileSync(process.env.PGSSLROOTCERT!, 'utf8').includes(
        'BEGIN CERTIFICATE',
      )
    )
      throw new Error('CATALOG_TEST_CA_INVALID');
    for (const key of environmentKeys) originalEnv[key] = process.env[key];
    admin = new pg.Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: {
        ca: readFileSync(process.env.PGSSLROOTCERT!, 'utf8'),
        rejectUnauthorized: true,
        servername: '127.0.0.1',
      },
    });
    const tls = await admin.query(
      'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
    );
    expect(tls.rows[0]?.ssl).toBe(true);
    await seedCatalogFixtures();

    jwksServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'public, max-age=60');
      if (request.url === '/.well-known/openid-configuration') {
        response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
        return;
      }
      if (request.url === '/jwks') {
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      response.writeHead(404).end('{}');
    });
    issuer = await listen(jwksServer);
    process.env.SECURITY_ISSUER = issuer;
    process.env.SECURITY_DISCOVERY_URL = `${issuer}/.well-known/openid-configuration`;
    process.env.SECURITY_JWKS_URL = `${issuer}/jwks`;

    const port = await freePort();
    catalogOrigin = `http://127.0.0.1:${port}`;
    const catalogEnvironment = {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      WINDIR: process.env.WINDIR ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      NODE_ENV: 'test',
      CATALOG_SVC_PORT: String(port),
      CATALOG_SVC_HOST: '127.0.0.1',
      PGHOST: process.env.PGHOST!,
      PGPORT: process.env.PGPORT!,
      PGDATABASE: process.env.PGDATABASE!,
      PGUSER: 'catalog_app',
      PGPASSWORD: process.env.COMBOS_TEST_CATALOG_PASSWORD,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: process.env.PGSSLROOTCERT!,
      G6_DATABASE_SCHEMA: 'catalog',
      G6_EXPECTED_ROLE: 'catalog_app',
      G6_CONNECTION_MODE: 'direct',
      SECURITY_ISSUER: issuer,
      SECURITY_DISCOVERY_URL: `${issuer}/.well-known/openid-configuration`,
      SECURITY_JWKS_URL: `${issuer}/jwks`,
      G6_READ_ONLY_DEMO_ENABLED: 'false',
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'false',
      CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED: 'false',
    };
    catalogProcess = spawn(process.execPath, [execPath], {
      cwd: process.env.COMBOS_TEST_CWD,
      env: catalogEnvironment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer) => {
      catalogOutput.push(chunk.toString('utf8').replace(/[\r\n]+$/, ''));
      catalogOutput = catalogOutput.slice(-100);
    };
    catalogProcess.stdout?.on('data', capture);
    catalogProcess.stderr?.on('data', capture);
    await waitForCatalog(makeToken());

    const catalogTls = await admin.query(
      `SELECT ssl FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid)
         WHERE a.usename = 'catalog_app' AND a.datname = current_database()`,
    );
    expect(catalogTls.rows.some((row) => row.ssl === true)).toBe(true);

    process.env.COMBOS_CATALOG_URL = catalogOrigin;
    process.env.COMBOS_CATALOG_SERVICE_BEARER = makeToken();
    process.env.COMBOS_AMQP_ENABLED = 'true';
    process.env.COMBOS_AMQP_URL = process.env.COMBOS_TEST_RABBITMQ_URL;
    database = new CombosDatabase();
    repository = new CombosRepository(database);
    publisherConnection = await amqp.connect(
      process.env.COMBOS_TEST_RABBITMQ_URL!,
    );
    publisher = await publisherConnection.createChannel();
    await publisher.assertExchange(exchange, 'topic', { durable: true });
    await publisher.assertQueue(queue, { durable: true });
    for (const route of routes)
      await publisher.bindQueue(queue, exchange, route);
    const combo = await database.query(async (client) => {
      await client.query('BEGIN');
      try {
        const inserted = await client.query(
          `INSERT INTO combos.combos(name, combo_price, currency)
             VALUES ('Catalog real integration', 5, 'PEN') RETURNING id`,
        );
        const id = String(inserted.rows[0]?.id);
        const items = await client.query(
          `INSERT INTO combos.combo_items(combo_id, sku, quantity)
             VALUES ($1, $2, 1), ($1, $3, 1), ($1, $4, 1), ($1, $5, 1)
             RETURNING id, sku`,
          [id, activeSku, inactiveSku, ineligibleBaseSku, opaqueSku],
        );
        await client.query('COMMIT');
        return {
          id,
          items: new Map(
            items.rows.map((row) => [String(row.sku), String(row.id)]),
          ),
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    comboId = combo.id;
    comboItemIds = combo.items;
    consumer = new CombosEventConsumer(repository);
    await consumer.onModuleInit();
    expect(consumer.readinessStatus()).toBe('ready');
  }, 60000);

  afterAll(async () => {
    await consumer?.onModuleDestroy();
    await publisher?.close().catch(() => undefined);
    await publisherConnection?.close().catch(() => undefined);
    if (comboId && database) {
      await database.query((client) =>
        client.query('DELETE FROM combos.combos WHERE id = $1', [comboId]),
      );
    }
    await database?.onModuleDestroy();
    await admin?.end();
    if (catalogProcess && catalogProcess.exitCode === null) {
      catalogProcess.kill();
      await Promise.race([
        once(catalogProcess, 'exit'),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 3000)),
      ]);
    }
    if (jwksServer?.listening)
      await new Promise<void>((resolveClose) =>
        jwksServer.close(() => resolveClose()),
      );
    for (const key of environmentKeys) {
      const original = originalEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }, 20000);

  it('serves real SKU context and enforces RS256, issuer, audience, scope and client allowlist', async () => {
    const active = await fetch(contextUrl(activeSku), {
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({
      sku: activeSku,
      productId: activeProductId,
      isVariant: false,
      active: true,
      eligible: true,
    });

    const inactive = await fetch(contextUrl(inactiveSku), {
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(inactive.status).toBe(200);
    expect(await inactive.json()).toMatchObject({
      sku: inactiveSku,
      productId: inactiveProductId,
      active: false,
      eligible: false,
    });

    const ineligible = await fetch(contextUrl(ineligibleBaseSku), {
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(ineligible.status).toBe(200);
    expect(await ineligible.json()).toMatchObject({
      sku: ineligibleBaseSku,
      productId: variantProductId,
      active: true,
      eligible: false,
    });

    const catalogClient = new CatalogSkuContextClient(
      catalogOrigin,
      () => process.env.COMBOS_CATALOG_SERVICE_BEARER,
    );
    await expect(
      catalogClient.getContext(inactiveSku, randomUUID()),
    ).rejects.toMatchObject<Partial<IntegrationFailure>>({
      dependency: 'CATALOG',
      reason: 'SKU_INACTIVO',
    });
    await expect(
      catalogClient.getContext(ineligibleBaseSku, randomUUID()),
    ).rejects.toMatchObject<Partial<IntegrationFailure>>({
      dependency: 'CATALOG',
      reason: 'SKU_INELEGIBLE',
    });

    const opaque = await fetch(contextUrl(opaqueSku), {
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(opaque.status).toBe(200);
    expect(await opaque.json()).toMatchObject({
      sku: opaqueSku,
      productId: variantProductId,
      isVariant: true,
      active: true,
      eligible: true,
    });

    const missing = await fetch(contextUrl('SKU-DOES-NOT-EXIST'), {
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'SKU_NO_ENCONTRADO' });

    const anonymous = await fetch(contextUrl(activeSku));
    expect(anonymous.status).toBe(401);
    const expired = await fetch(contextUrl(activeSku), {
      headers: {
        authorization: `Bearer ${makeToken({ exp: Math.floor(Date.now() / 1000) - 1 })}`,
      },
    });
    expect(expired.status).toBe(401);
    const invalidSignature = await fetch(contextUrl(activeSku), {
      headers: {
        authorization: `Bearer ${makeToken({}, wrongSigningKey.privateKey)}`,
      },
    });
    expect(invalidSignature.status).toBe(401);
    const wrongIssuer = await fetch(contextUrl(activeSku), {
      headers: {
        authorization: `Bearer ${makeToken({ iss: `${issuer}/wrong` })}`,
      },
    });
    expect(wrongIssuer.status).toBe(401);
    const wrongAudience = await fetch(contextUrl(activeSku), {
      headers: {
        authorization: `Bearer ${makeToken({ aud: ['api-other'] })}`,
      },
    });
    expect(wrongAudience.status).toBe(401);
    const insufficientScope = await fetch(contextUrl(activeSku), {
      headers: {
        authorization: `Bearer ${makeToken({ scope: 'catalogo:escribir' })}`,
      },
    });
    expect(insufficientScope.status).toBe(403);
    const unauthorizedClient = await fetch(contextUrl(activeSku), {
      headers: {
        authorization: `Bearer ${makeToken({ sub: 'modulo-no-autorizado' })}`,
      },
    });
    expect(unauthorizedClient.status).toBe(403);
  }, 30000);

  it('returns a safe technical failure when Catalog cannot authenticate to PostgreSQL', async () => {
    await admin.query('ALTER ROLE catalog_app NOLOGIN');
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE usename = 'catalog_app' AND datname = current_database()
           AND pid <> pg_backend_pid()`,
    );
    try {
      const response = await fetch(contextUrl(activeSku), {
        headers: { authorization: `Bearer ${makeToken()}` },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'SERVICIO_NO_DISPONIBLE',
      });
    } finally {
      await admin.query('ALTER ROLE catalog_app LOGIN');
    }
    await waitForCatalog(makeToken());
  }, 30000);

  it('maps a product event through real Catalog; auth rejection remains unacked and recovers by Rabbit redelivery', async () => {
    const deniedEventId = randomUUID();
    process.env.COMBOS_CATALOG_SERVICE_BEARER = makeToken({
      scope: 'catalogo:escribir',
    });
    await publishProductDeactivation(deniedEventId);
    const pauseDeadline = Date.now() + 12000;
    while (consumer.readinessStatus() === 'ready' && Date.now() < pauseDeadline)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    expect(consumer.readinessStatus()).toBe('not_ready');
    expect(await waitForInbox(deniedEventId, undefined, 200)).toBeNull();

    await consumer.onModuleDestroy();
    process.env.COMBOS_CATALOG_SERVICE_BEARER = makeToken();
    consumer = new CombosEventConsumer(repository);
    await consumer.onModuleInit();
    expect(consumer.readinessStatus()).toBe('ready');
    expect(await waitForInbox(deniedEventId)).toBe('PROCESSED');

    const projected = await database.query((client) =>
      client.query(
        `SELECT p.catalog_deactivated FROM combos.component_projection p
           JOIN combos.combo_items i ON i.id = p.combo_item_id
           WHERE i.id = $1`,
        [comboItemIds.get(activeSku)],
      ),
    );
    expect(projected.rows[0]?.catalog_deactivated).toBe(true);
    const inbox = await database.query((client) =>
      client.query(
        `SELECT count(*)::int AS count FROM combos.inbox
           WHERE message_id = $1 AND handler = 'combos.catalog.product.deactivated'`,
        [deniedEventId],
      ),
    );
    expect(inbox.rows[0]?.count).toBe(1);
  }, 30000);

  it('adapts opaque event correlation for Catalog HTTP and preserves the original correlation durably', async () => {
    const messageId = randomUUID();
    const eventCorrelationId = 'catalog-event:product/84';
    const rejected = await fetch(contextUrl(activeSku), {
      headers: {
        authorization: `Bearer ${makeToken()}`,
        'x-correlation-id': eventCorrelationId,
      },
    });
    expect(rejected.status).toBe(400);
    const client = new CatalogSkuContextClient(catalogOrigin, () =>
      makeToken(),
    );
    await expect(
      client.getContextForMapping(activeSku, eventCorrelationId),
    ).rejects.toMatchObject<Partial<IntegrationFailure>>({
      dependency: 'CATALOG',
      reason: 'UPSTREAM_FAILURE',
      upstreamStatus: 400,
    });

    await publishProductDeactivation(messageId, eventCorrelationId);
    expect(await waitForInbox(messageId)).toBe('PROCESSED');
    const inbox = await database.query((client) =>
      client.query(
        `SELECT correlation_id, payload FROM combos.inbox
           WHERE message_id = $1 AND handler = 'combos.catalog.product.deactivated'`,
        [messageId],
      ),
    );
    expect(inbox.rows[0]).toMatchObject({
      correlation_id: eventCorrelationId,
      payload: { correlation_id: eventCorrelationId },
    });
  }, 30000);

  it('strips control characters from correlation logs while preserving the event value in Inbox', async () => {
    const messageId = randomUUID();
    const eventCorrelationId = 'catalog-event:\r\n\t\u007f84';
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    try {
      await publishEvent(
        'catalog.product.deactivated',
        {
          product_id: activeProductId,
          product_version: 3,
          changed_at: new Date().toISOString(),
        },
        messageId,
        eventCorrelationId,
      );
      expect(await waitForInbox(messageId)).toBe('PROCESSED');

      const inbox = await database.query((client) =>
        client.query(
          `SELECT correlation_id FROM combos.inbox WHERE message_id = $1
             AND handler = 'combos.catalog.product.deactivated'`,
          [messageId],
        ),
      );
      expect(inbox.rows[0]?.correlation_id).toBe(eventCorrelationId);

      const mappingLog = logSpy.mock.calls
        .map(([message]) => {
          try {
            return JSON.parse(String(message)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (entry) =>
            entry?.event === 'catalog_request_correlation_mapped' &&
            entry.message_id === messageId,
        );
      expect(mappingLog).toMatchObject({
        message_id: messageId,
        event_correlation_id: 'catalog-event:84',
      });
      const serializedLog = JSON.stringify(mappingLog);
      expect(
        [...serializedLog].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint < 0x20 || codePoint === 0x7f;
        }),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  }, 30000);

  it('processes real SKU and Inventory events without projecting aggregate stock', async () => {
    const changedAt = new Date().toISOString();
    const skuEventId = await publishEvent('catalog.sku.deactivated', {
      sku: opaqueSku,
      product_id: variantProductId,
      sku_version: 2,
      changed_at: changedAt,
    });
    expect(
      await waitForInbox(skuEventId, 'combos.catalog.sku.deactivated'),
    ).toBe('PROCESSED');

    const stockEventId = await publishEvent('inventory.stock.changed', {
      sku: opaqueSku,
      location_id: randomUUID(),
      on_hand: 8,
      reserved: 2,
      blocked: 1,
      available: 5,
      estado: 'DISPONIBLE',
      stock_version: 3,
      updated_at: changedAt,
    });
    expect(
      await waitForInbox(stockEventId, 'combos.inventory.stock.changed'),
    ).toBe('PROCESSED');

    const projection = await database.query((client) =>
      client.query(
        `SELECT catalog_deactivated, projected_available, inventory_observed_at
           FROM combos.component_projection WHERE combo_item_id = $1`,
        [comboItemIds.get(opaqueSku)],
      ),
    );
    expect(projection.rows[0]).toMatchObject({
      catalog_deactivated: true,
      projected_available: null,
    });
    expect(projection.rows[0]?.inventory_observed_at).toBeTruthy();
    await expect(
      new CombosSvcService(database, repository).availability(comboId),
    ).resolves.toMatchObject({
      verificable: false,
      cantidadInformativa: null,
      estadoActualizacion: 'INCOMPLETA',
    });
  }, 20000);
});
