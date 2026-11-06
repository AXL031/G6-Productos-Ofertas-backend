import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PricingDatabase } from '../src/persistence/pricing.database.js';
import { PricingRepository } from '../src/persistence/pricing.repository.js';
import { PricingMutations } from '../src/application/pricing-mutations.js';
import { PricingOutboxRelay } from '../src/messaging/outbox-relay.js';
import { createPricingPriceChangedFacts } from '../src/messaging/pricing-fact.js';
import { outbox } from '../src/persistence/pricing.schema.js';
import { IsolatedPostgres } from './isolated-postgres.js';
import { IsolatedRabbitmq } from './isolated-rabbitmq.js';
import { SignedUser } from './signed-user.js';

const exec = promisify(execFile);
const auditImage =
  'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';

class IsolatedAuditPostgres {
  private readonly name = `pricing-audit-route-${randomUUID()}`;
  private created = false;
  admin?: Pool;
  runtimeUrl = '';

  async start(): Promise<void> {
    const password = randomUUID();
    await exec(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        this.name,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        'POSTGRES_DB=price_audit_test',
        auditImage,
      ],
      { timeout: 60000 },
    );
    this.created = true;
    const { stdout } = await exec('docker', ['port', this.name, '5432/tcp']);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
    if (!port) throw new Error('Puerto de PostgreSQL de Audit inválido.');
    this.admin = new Pool({
      connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/price_audit_test`,
      ssl: false,
      connectionTimeoutMillis: 1000,
    });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await this.admin.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await delay(250);
      }
    }
    if (!ready) throw new Error('PostgreSQL de Audit aislado no disponible.');
    const fixture = await readFile(
      new URL(
        '../../price-audit-svc/test/fixtures/price-audit.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256')
      .update(fixture.replaceAll('\r\n', '\n'))
      .digest('hex');
    if (
      digest !==
      '7d890955717025572da03d258168d81e9b7fa38c797f1b697527f0d4cab89afc'
    )
      throw new Error('El SQL normativo de Audit cambió; fixture cancelada.');
    await this.admin.query(`
      CREATE ROLE po_price_audit_owner NOLOGIN;
      CREATE ROLE price_audit_app LOGIN PASSWORD '${password}';
      CREATE SCHEMA price_audit AUTHORIZATION po_price_audit_owner;
      CREATE ROLE price_audit_archiver NOLOGIN;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      CREATE SCHEMA foreign_fixture;
      CREATE TABLE foreign_fixture.secret (id integer);
      BEGIN; SET LOCAL ROLE po_price_audit_owner; ${fixture} COMMIT;
    `);
    const migration = await readFile(
      new URL(
        '../../price-audit-svc/migrations/0002_typed_price_change.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await this.admin.query(
      `BEGIN; SET LOCAL ROLE po_price_audit_owner; ${migration} COMMIT;`,
    );
    this.runtimeUrl = `postgresql://price_audit_app:${password}@127.0.0.1:${port}/price_audit_test`;
  }

  async stop(): Promise<void> {
    try {
      await this.admin?.end();
    } finally {
      if (this.created)
        await exec('docker', ['rm', '--force', '--volumes', this.name], {
          timeout: 15000,
        });
    }
  }
}

describe.skipIf(process.env.PRICING_TEST_AUDIT !== '1')(
  'Pricing Outbox → Price Audit production process, isolated PostgreSQL/RabbitMQ',
  () => {
    const pricingPg = new IsolatedPostgres();
    const auditPg = new IsolatedAuditPostgres();
    const broker = new IsolatedRabbitmq();
    const identity = new SignedUser();
    const config = {
      nodeEnv: 'test' as const,
      port: 3002,
      databaseUrl: '',
      databaseSsl: false as const,
      priceChangedPublishingEnabled: true,
    };
    let database: PricingDatabase;
    let relay: PricingOutboxRelay;
    let mutations: PricingMutations;
    let child: ChildProcess | undefined;
    let auditPort = 0;
    let exitCode: number | null = null;
    let childLogs = '';

    function sanitizedLogs(): string {
      return childLogs
        .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DATABASE_URL]')
        .replace(/amqps?:\/\/[^\s"']+/gi, '[AMQP_URL]')
        .slice(-4000);
    }

    async function freePort(): Promise<number> {
      const server: Server = createServer();
      await new Promise<void>((resolveListen, reject) =>
        server.listen(0, '127.0.0.1', (error) =>
          error ? reject(error) : resolveListen(),
        ),
      );
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      return port;
    }

    async function waitForAudit(): Promise<void> {
      const url = `http://127.0.0.1:${auditPort}/health/ready`;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (exitCode !== null)
          throw new Error(
            `Price Audit terminó durante arranque (código ${exitCode}).\n${sanitizedLogs()}`,
          );
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.status === 200) return;
        } catch {
          /* El proceso sigue arrancando. */
        }
        await delay(250);
      }
      throw new Error('Price Audit no alcanzó readiness en 20 segundos.');
    }

    async function waitForRow(sku: string): Promise<void> {
      for (let attempt = 0; attempt < 80; attempt++) {
        const found = await auditPg.admin!.query(
          'SELECT count(*)::int AS total FROM price_audit.price_audit_log WHERE sku=$1',
          [sku],
        );
        if (found.rows[0].total === 1) return;
        await delay(100);
      }
      throw new Error('Price Audit no persistió el evento tipado recibido.');
    }

    beforeAll(async () => {
      await exec(
        process.execPath,
        [
          resolve(process.cwd(), 'node_modules/@nestjs/cli/bin/nest.js'),
          'build',
          'price-audit-svc',
        ],
        { timeout: 120000 },
      );
      await Promise.all([
        pricingPg.start(),
        auditPg.start(),
        broker.start(),
        identity.start(),
      ]);
      config.databaseUrl = pricingPg.runtimeUrl;
      database = new PricingDatabase(config);
      const repository = new PricingRepository(database);
      mutations = new PricingMutations(repository);
      relay = new PricingOutboxRelay(repository, config);
      auditPort = await freePort();
      child = spawn(
        'node',
        [resolve(process.cwd(), 'dist/apps/price-audit-svc/main.js')],
        {
          cwd: tmpdir(),
          env: {
            ...process.env,
            NODE_ENV: 'test',
            PRICE_AUDIT_SVC_PORT: String(auditPort),
            DATABASE_URL: auditPg.runtimeUrl,
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: `${identity.issuer}/jwks`,
            PRICE_AUDIT_AMQP_URL: broker.url.split('?')[0],
            AUDIT_HOT_RETENTION_MONTHS: '24',
            AUDIT_ARCHIVE_RETENTION_YEARS: '5',
            NODE_TLS_REJECT_UNAUTHORIZED: undefined,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        childLogs += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        childLogs += chunk.toString();
      });
      child.on('exit', (code) => {
        exitCode = code;
      });
      await waitForAudit();
    }, 180000);

    afterAll(async () => {
      if (child && child.exitCode === null) {
        child.kill();
        await new Promise<void>((resolveClose) =>
          child!.once('exit', () => resolveClose()),
        );
      }
      await identity.stop();
      await database?.onApplicationShutdown();
      await broker.stop();
      await Promise.allSettled([pricingPg.stop(), auditPg.stop()]);
    }, 30000);

    it('persiste el cambio efectivo y Outbox, publica, audita en módulo productivo, recupera por API y deduplica reentrega', async () => {
      const sku = `AUDIT-${randomUUID()}`;
      const productId = randomUUID();
      const correlationId = randomUUID();
      const operationId = randomUUID();
      const now = new Date();
      const input = {
        precioRegular: '49.95',
        accionPrecioOferta: 'ELIMINAR' as const,
        currency: 'PEN',
        motivoCambio: 'ALTA_PRODUCTO',
        usuarioId: '74ed2f19-7e70-4915-a6f6-bbc691b82587',
      };
      await mutations.update(
        { sku },
        'MARKETPLACE',
        input,
        0n,
        now,
        (before, after) =>
          createPricingPriceChangedFacts(before, after, {
            actor: input.usuarioId,
            correlationId,
            at: now,
            operation: 'actualizarPrecioSku',
            productId,
            operationId,
          }),
      );
      const [stored] = await database.db.select().from(outbox);
      expect(stored).toMatchObject({
        eventName: 'pricing.price.changed',
        kind: 'event',
        correlationId,
        operationId,
        publishedAt: null,
        payload: {
          target_type: 'SKU',
          product_id: productId,
          sku,
          price_type: 'REGULAR',
          new_price: '49.95',
        },
      });
      expect(await relay.runOnce(broker.url)).toEqual({
        selected: 1,
        published: 1,
      });
      const [published] = await database.db.select().from(outbox);
      expect(published.publishedAt).toBeInstanceOf(Date);
      await waitForRow(sku);

      const response = await fetch(
        `http://127.0.0.1:${auditPort}/api/v1/auditoria-precios?sku=${encodeURIComponent(sku)}`,
        {
          headers: { Authorization: `Bearer ${identity.token()}` },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        target_type: 'SKU',
        product_id: productId,
        sku,
        tipo_precio: 'REGULAR',
        precio_anterior: null,
        precio_nuevo: 49.95,
      });

      const event = {
        message_id: stored.messageId,
        schema_version: 1,
        occurred_at: stored.occurredAt.toISOString(),
        correlation_id: stored.correlationId,
        causation_id: stored.causationId,
        operation_id: stored.operationId,
        producer: 'pricing-svc',
        kind: 'event',
        name: stored.eventName,
        data: stored.payload,
      };
      broker.channel!.publish(
        'po.eventos.x',
        'pricing.price.changed',
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          contentType: 'application/json',
          messageId: stored.messageId,
          correlationId: stored.correlationId,
        },
      );
      await delay(500);
      const counts = await auditPg.admin!.query(
        `SELECT (SELECT count(*)::int FROM price_audit.price_audit_log WHERE sku=$1) AS audit_rows,
                (SELECT count(*)::int FROM price_audit.inbox WHERE message_id=$2) AS inbox_rows`,
        [sku, stored.messageId],
      );
      expect(counts.rows[0]).toEqual({ audit_rows: 1, inbox_rows: 1 });
    }, 30000);
  },
);
