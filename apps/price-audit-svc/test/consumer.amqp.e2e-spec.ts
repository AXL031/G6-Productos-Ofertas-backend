import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { connect } from 'amqplib';
import { PriceAuditSvcModule } from '../src/price-audit-svc.module.js';
import { AuditConsumer } from '../src/messaging/audit-consumer.js';
import { IsolatedAuditPostgres } from './isolated-postgres.js';
import { IsolatedRabbitmq } from './isolated-rabbitmq.js';
import { SignedUser } from './signed-user.js';

describe.skipIf(process.env.PRICE_AUDIT_TEST_AMQP !== '1')(
  'AMQP tipado - Inbox/log - HTTP con decoder productivo',
  () => {
    const postgres = new IsolatedAuditPostgres();
    const broker = new IsolatedRabbitmq();
    const identity = new SignedUser();
    let exportDirectory: string;
    let app: INestApplication;
    let consumer: AuditConsumer;
    const rows = async (sku: string) =>
      (
        await postgres.admin!.query(
          'SELECT count(*)::int AS total FROM price_audit.price_audit_log WHERE sku=$1',
          [sku],
        )
      ).rows[0].total;
    const envelope = (sku: string) => ({
      message_id: randomUUID(),
      correlation_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      producer: 'pricing-svc',
      kind: 'event',
      name: 'pricing.price.changed',
      data: {
        target_type: 'SKU',
        product_id: 'fixture-product',
        sku,
        channel_id: 'MARKETPLACE',
        currency: 'PEN',
        price_type: 'REGULAR',
        previous_price: null,
        new_price: '12.30',
        operation: 'CREACION',
        reason: 'ALTA_PRODUCTO',
        price_version: 1,
        valid_from: new Date().toISOString(),
        batch_id: null,
        actor: { user_id: null, email: null, ip: null },
      },
    });
    async function publish(body: unknown) {
      const connection = await connect(broker.url, { timeout: 2000 });
      connection.on('error', () => undefined);
      try {
        const channel = await connection.createConfirmChannel();
        channel.on('error', () => undefined);
        channel.publish(
          'po.eventos.x',
          'pricing.price.changed',
          Buffer.from(JSON.stringify(body)),
          { persistent: true, contentType: 'application/json' },
        );
        await channel.waitForConfirms();
        await channel.close();
      } finally {
        await connection.close().catch(() => undefined);
      }
    }
    beforeAll(async () => {
      await postgres.start();
      await broker.start();
      await identity.start();
      exportDirectory = await mkdtemp(join(tmpdir(), 'g6-audit-export-'));
      const module = await Test.createTestingModule({
        imports: [
          PriceAuditSvcModule.forRoot({
            NODE_ENV: 'test',
            PRICE_AUDIT_SVC_PORT: '3003',
            DATABASE_URL: postgres.runtimeUrl,
            AUTH_ISSUER: identity.issuer,
            AUTH_JWKS_URL: identity.issuer + '/jwks',
            PRICE_AUDIT_AMQP_URL: broker.url.split('?')[0],
            AUDIT_EXPORT_DIRECTORY: exportDirectory,
          }),
        ],
      }).compile();
      app = module.createNestApplication({ logger: false });
      await app.init();
      consumer = app.get(AuditConsumer);
      await vi.waitFor(() => expect(consumer.available).toBe(true), {
        timeout: 15000,
      });
    }, 120000);
    afterAll(async () => {
      await app?.close();
      await identity.stop();
      await broker.stop();
      await postgres.stop();
      if (exportDirectory)
        await rm(exportDirectory, { recursive: true, force: true });
    });
    it('consume, confirma commit, consulta por JWT y deduplica un redelivery con el mismo message_id', async () => {
      const event = envelope('amqp-once');
      await publish(event);
      await expect.poll(() => rows('amqp-once'), { timeout: 10000 }).toBe(1);
      await publish(event);
      await setTimeout(300);
      expect(await rows('amqp-once')).toBe(1);
      const response = await request(app.getHttpServer())
        .get('/api/v1/auditoria-precios?sku=amqp-once')
        .set('Authorization', 'Bearer ' + identity.token())
        .expect(200);
      expect(response.body.items[0]).toMatchObject({
        precio_anterior: null,
        precio_nuevo: 12.3,
        tipo_operacion: 'CREACION',
      });
      expect(
        (
          await postgres.admin!.query(
            'SELECT count(*)::int AS total FROM price_audit.inbox WHERE message_id=$1',
            [event.message_id],
          )
        ).rows[0].total,
      ).toBe(1);
    });
    it('persiste PRODUCTO global y precision decimal sin SKU ficticio', async () => {
      const event = envelope('unused');
      const productEvent = {
        ...event,
        data: {
          ...event.data,
          target_type: 'PRODUCTO',
          sku: null,
          channel_id: null,
          operation: 'MODIFICACION',
          previous_price: '6.0001',
          new_price: '7.0001',
        },
      };
      await publish(productEvent);
      const saved = async () =>
        (
          await postgres.admin!.query(
            'SELECT l.* FROM price_audit.price_audit_log l JOIN price_audit.inbox i ON i.id=l.inbox_id WHERE i.message_id=$1',
            [event.message_id],
          )
        ).rows;
      await expect
        .poll(async () => (await saved()).length, { timeout: 10000 })
        .toBe(1);
      expect((await saved())[0]).toMatchObject({
        target_type: 'PRODUCTO',
        sku: null,
        canal_origen: null,
        precio_anterior: '6.0001',
        precio_nuevo: '7.0001',
        variacion_porcentual: '16.67',
      });
      const row = (await saved())[0];
      const response = await request(app.getHttpServer())
        .get('/api/v1/auditoria-precios/' + row.id_auditoria)
        .set('Authorization', 'Bearer ' + identity.token())
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    });
    it('NACK/rollback conserva entrega y recupera después de un fallo de persistencia', async () => {
      const event = envelope('db-recovery');
      await postgres.admin!.query(
        'REVOKE INSERT ON price_audit.price_audit_log FROM price_audit_app',
      );
      try {
        await publish(event);
        await setTimeout(500);
        expect(await rows('db-recovery')).toBe(0);
        expect(
          (
            await postgres.admin!.query(
              'SELECT count(*)::int AS total FROM price_audit.inbox WHERE message_id=$1',
              [event.message_id],
            )
          ).rows[0].total,
        ).toBe(0);
      } finally {
        await postgres.admin!.query(
          'GRANT INSERT ON price_audit.price_audit_log TO price_audit_app',
        );
      }
      await expect.poll(() => rows('db-recovery'), { timeout: 15000 }).toBe(1);
      expect(consumer.paused).toBe(false);
    });
    it.each([
      { producer: 'otro-servicio' },
      { occurred_at: '2026-02-30T00:00:00Z' },
      {
        data: {
          ...envelope('invalid').data,
          valid_from: '2026-02-30T00:00:00Z',
        },
      },
      { data: { fixture_sku: 'legacy-generic-data' } },
    ])(
      'retiene envelope incompatible o GenericData antiguo sin ACK: %j',
      async (incompatible) => {
        const incoming = { ...envelope('invalid'), ...incompatible };
        await publish(incoming);
        await expect.poll(() => consumer.paused, { timeout: 10000 }).toBe(true);
        await expect
          .poll(
            async () =>
              (await broker.channel!.checkQueue('po.auditoria-precios.q'))
                .messageCount,
            { timeout: 10000 },
          )
          .toBe(1);
        expect(await rows('invalid')).toBe(0);
        expect(
          (
            await postgres.admin!.query(
              'SELECT count(*)::int AS total FROM price_audit.inbox WHERE message_id=$1',
              [incoming.message_id],
            )
          ).rows[0].total,
        ).toBe(0);
        await request(app.getHttpServer()).get('/health/ready').expect(503);
        await request(app.getHttpServer()).get('/health/live').expect(200);
        const invalid = await broker.channel!.get('po.auditoria-precios.q');
        if (!invalid) throw new Error('El mensaje no quedó retenido.');
        broker.channel!.ack(invalid); // Disposición manual exclusiva de la fixture, no política de producción.
        consumer.start();
        await expect
          .poll(() => consumer.available, { timeout: 10000 })
          .toBe(true);
      },
    );
    it('reconecta tras interrupción de broker sin sustituir disponibilidad por liveness', async () => {
      await broker.pause();
      try {
        await expect
          .poll(() => consumer.available, { timeout: 20000 })
          .toBe(false);
      } finally {
        await broker.resume();
      }
      await broker.reconnect();
      await expect
        .poll(() => consumer.available, { timeout: 20000 })
        .toBe(true);
      const event = envelope('broker-recovery');
      await publish(event);
      await expect
        .poll(() => rows('broker-recovery'), { timeout: 10000 })
        .toBe(1);
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    }, 45000);
    if (process.env.G6_PERFORMANCE_HTTP === '1') {
      it('mide HTTP Nest con PostgreSQL/RabbitMQ reales en el harness aislado', async () => {
        const sku = 'amqp-once';
        expect(await rows(sku)).toBe(1);
        await app.listen(0, '127.0.0.1');
        const base = await app.getUrl();
        const listPath = `/api/v1/auditoria-precios?sku=${sku}`;
        const bearer = identity.token();
        const headers = { authorization: `Bearer ${bearer}` };
        const auditId = (
          await postgres.admin!.query(
            'SELECT id_auditoria FROM price_audit.price_audit_log WHERE sku=$1 ORDER BY timestamp DESC LIMIT 1',
            [sku],
          )
        ).rows[0]?.id_auditoria as string | undefined;
        if (!auditId)
          throw new Error('No se encontró el registro HTTP de auditoría');
        const createdExport = await request(app.getHttpServer())
          .post('/api/v1/auditoria-precios/exportaciones')
          .set('Authorization', `Bearer ${bearer}`)
          .send({ formato: 'CSV', sku })
          .expect(202);
        const exportId = createdExport.body.export_id as string;
        const exportPath = `/api/v1/auditoria-precios/exportaciones/${exportId}`;
        const exportFilePath = `${exportPath}/archivo`;
        const exportDeadline = Date.now() + 30000;
        while (Date.now() < exportDeadline) {
          const job = await fetch(base + exportPath, { headers });
          const body = await job.json();
          if (body.status === 'COMPLETED') break;
          if (
            body.status === 'FAILED_GENERAL' ||
            body.status === 'FAILED_LIMIT'
          )
            throw new Error(`Audit export terminó en estado ${body.status}`);
          await setTimeout(250);
        }
        const completedExport = await fetch(base + exportPath, { headers });
        const completedExportBody = await completedExport.json();
        if (completedExportBody.status !== 'COMPLETED')
          throw new Error(
            `Audit export no terminó: ${completedExportBody.status}`,
          );
        const profiles = [
          { path: listPath, endpoint: `GET ${listPath}` },
          {
            path: `/api/v1/auditoria-precios/${auditId}`,
            endpoint: 'GET /api/v1/auditoria-precios/{auditId}',
          },
          {
            path: exportPath,
            endpoint: 'GET /api/v1/auditoria-precios/exportaciones/{exportId}',
          },
          {
            path: exportFilePath,
            endpoint:
              'GET /api/v1/auditoria-precios/exportaciones/{exportId}/archivo',
          },
        ];
        const percentile = (sorted: number[], fraction: number) =>
          sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
        const rowsOut: Array<Record<string, unknown>> = [];
        let totalFailures = 0;
        let totalTimeouts = 0;
        const explain = (
          await postgres.admin!.query(
            'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM price_audit.price_audit_log WHERE sku=$1 ORDER BY timestamp DESC, id_auditoria DESC LIMIT 20 OFFSET 0',
            [sku],
          )
        ).rows[0]?.['QUERY PLAN'];
        for (const profileCase of profiles) {
          const { path } = profileCase;
          const requestUrlBytes = Buffer.byteLength(`GET ${path} HTTP/1.1\r\n`);
          const bearerBytes = Buffer.byteLength(
            `authorization: Bearer ${bearer}\r\n`,
          );
          for (const concurrency of [1, 8, 32]) {
            for (let index = 0; index < 10; index += 1) {
              const warmup = await fetch(base + path, {
                headers,
                signal: AbortSignal.timeout(10000),
              });
              await warmup.arrayBuffer();
              if (!warmup.ok)
                throw new Error(`Price Audit warmup HTTP ${warmup.status}`);
            }
            await postgres.admin!.query('SELECT pg_stat_statements_reset()');
            const latencies: number[] = [];
            let responseBodyBytes = 0;
            let levelFailures = 0;
            let levelTimeouts = 0;
            let next = 0;
            const samples = 1000;
            const started = performance.now();
            await Promise.all(
              Array.from({ length: concurrency }, async () => {
                while (true) {
                  const index = next++;
                  if (index >= samples) return;
                  const requestStarted = performance.now();
                  try {
                    const response = await fetch(base + path, {
                      headers,
                      signal: AbortSignal.timeout(10000),
                    });
                    const body = await response.arrayBuffer();
                    latencies.push(performance.now() - requestStarted);
                    if (response.ok) responseBodyBytes += body.byteLength;
                    else levelFailures += 1;
                  } catch (error) {
                    latencies.push(performance.now() - requestStarted);
                    levelFailures += 1;
                    if (error?.name === 'TimeoutError') levelTimeouts += 1;
                  }
                }
              }),
            );
            const durationMs = performance.now() - started;
            const sorted = latencies.sort((left, right) => left - right);
            totalFailures += levelFailures;
            totalTimeouts += levelTimeouts;
            const sqlStats = await postgres.admin!.query<{
              calls: string;
              shared_blks_hit: string;
              shared_blks_read: string;
            }>(`
            SELECT COALESCE(sum(calls),0)::text AS calls,
                   COALESCE(sum(shared_blks_hit),0)::text AS shared_blks_hit,
                   COALESCE(sum(shared_blks_read),0)::text AS shared_blks_read
              FROM pg_stat_statements
             WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
               AND query NOT LIKE '%pg_stat_statements%'
          `);
            const pool = await postgres.admin!.query<{
              total: number;
              active: number;
            }>(`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE state='active')::int AS active
              FROM pg_stat_activity
             WHERE datname=current_database() AND usename='price_audit_app'
          `);
            rowsOut.push({
              evidenceClass: 'HTTP_PROCESS_BENCHMARK',
              service: 'price-audit-svc',
              endpoint: profileCase.endpoint,
              variant: process.env.G6_PERFORMANCE_VARIANT ?? 'candidate',
              sha:
                process.env.G6_PERFORMANCE_SHA ??
                process.env.GITHUB_SHA ??
                'local-unset',
              concurrency,
              samples,
              warmupRequests: 10,
              p50Ms: percentile(sorted, 0.5),
              p95Ms: percentile(sorted, 0.95),
              p99Ms: percentile(sorted, 0.99),
              throughputRequestsPerSecond: (samples * 1000) / durationMs,
              durationMs,
              requestUrlBytes: requestUrlBytes * samples,
              requestBodyBytes: 0,
              requestBearerBytes: bearerBytes * samples,
              responseBodyBytes,
              failures: levelFailures,
              timeouts: levelTimeouts,
              sqlCalls: Number(sqlStats.rows[0]?.calls ?? 0),
              sharedBlocksHit: Number(sqlStats.rows[0]?.shared_blks_hit ?? 0),
              sharedBlocksRead: Number(sqlStats.rows[0]?.shared_blks_read ?? 0),
              poolConnectionsObservedAfter: pool.rows[0]?.total ?? null,
              activeConnectionsObservedAfter: pool.rows[0]?.active ?? null,
            });
          }
        }
        const output = resolve(
          process.env.G6_PERFORMANCE_OUTPUT ?? '.ci/performance',
        );
        await mkdir(output, { recursive: true });
        const profile = {
          schemaVersion: 1,
          evidenceClass: 'HTTP_PROCESS_BENCHMARK',
          benchmark: 'price-audit-http-postgres-rabbitmq',
          service: 'price-audit-svc',
          variant: process.env.G6_PERFORMANCE_VARIANT ?? 'candidate',
          sha:
            process.env.G6_PERFORMANCE_SHA ??
            process.env.GITHUB_SHA ??
            'local-unset',
          composition:
            'Nest TestingModule assembled from PriceAuditSvcModule, loopback HTTP listener, isolated PostgreSQL 16 and RabbitMQ, signed local test issuer; not dist/main process',
          routeCoverage: profiles.map(({ endpoint }) => endpoint),
          sampleDefinition:
            '1,000 measured requests per concurrency after 10 warmups',
          requestBytesDefinition:
            'request-target and bearer header counted separately; excludes transport framing and other headers',
          responseBytesDefinition: 'exact response body bytes',
          recovery:
            'RabbitMQ reconnection exercised by the same E2E suite; no outage during HTTP load window',
          measurement: {
            sqlQueryCount: 'pg_stat_statements reset per concurrency window',
            sharedBuffers:
              'pg_stat_statements shared_blks_hit/shared_blks_read per window',
            explainPlan: explain,
            poolOccupancy:
              'post-window pg_stat_activity snapshot for price_audit_app; peak in-window occupancy unavailable',
          },
          results: rowsOut,
          failures: totalFailures,
          timeouts: totalTimeouts,
        };
        await writeFile(
          join(output, 'price-audit-http-profile.json'),
          `${JSON.stringify(profile, null, 2)}\n`,
        );
        const columns = Object.keys(rowsOut[0] ?? {});
        await writeFile(
          join(output, 'price-audit-http-profile.csv'),
          `${[columns.join(','), ...rowsOut.map((row) => columns.map((key) => JSON.stringify(row[key] ?? '')).join(','))].join('\n')}\n`,
        );
      }, 240000);
    }
  },
);
