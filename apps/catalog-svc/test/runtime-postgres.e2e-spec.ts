import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createJwtFixture } from './support/jwt-fixture.js';

// Both modes use a real disposable PostgreSQL TLS server. No Supabase credentials,
// replacements for Database, commercial fixtures, or runtime mocks are involved.
const dockerAvailable =
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).status === 0;
const performanceEnabled = process.env.G6_PERFORMANCE_HTTP === '1';
const performanceOutput = resolve(
  process.env.G6_PERFORMANCE_OUTPUT ?? '.ci/performance',
);

function command(executable: string, args: string[], input?: string): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    input,
    timeout: 120000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      basename(executable) + ' failed in disposable PostgreSQL setup',
    );
  return result.stdout.trim();
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replaceAll('ci-runtime-admin', '[redacted]')
    .replaceAll('ci-runtime-password', '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(-12000);
}

function startupDiagnostics(container: string, childOutput = ''): string {
  const state = spawnSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}',
      container,
    ],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  const logs = spawnSync('docker', ['logs', '--tail', '80', container], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return [
    `postgres=${sanitizeDiagnostic(state.stdout || state.stderr || 'inspect unavailable')}`,
    `postgres_tail=${sanitizeDiagnostic(`${logs.stdout ?? ''}${logs.stderr ?? ''}`)}`,
    `catalog_child_tail=${sanitizeDiagnostic(childOutput)}`,
  ].join('\n');
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function until(
  check: () => boolean | Promise<boolean>,
  timeout = 30000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(200);
  }
  throw new Error(
    'Disposable PostgreSQL/process did not become available within timeout',
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

describe.skipIf(!dockerAvailable)(
  'Catalog real startup, PostgreSQL TLS and dependency loss',
  () => {
    const container = 'catalog-runtime-' + process.pid + '-' + Date.now();
    let directory: string;
    let certificate: string;
    let wrongCertificate: string;
    let databasePort: string;
    const main = resolve('dist/apps/catalog-svc/main.js');

    const ready = () =>
      spawnSync(
        'docker',
        ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        {
          timeout: 5000,
          windowsHide: true,
          stdio: 'ignore',
        },
      ).status === 0;

    beforeAll(async () => {
      // CI runs e2e before its build step. Compile the actual production entry point.
      command(process.execPath, [
        resolve('node_modules/@nestjs/cli/bin/nest.js'),
        'build',
        'catalog-svc',
      ]);
      directory = mkdtempSync(join(tmpdir(), 'catalog-runtime-'));
      const certs = join(directory, 'certs');
      mkdirSync(certs);
      chmodSync(certs, 0o755);
      certificate = join(certs, 'server.crt');
      command('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        join(certs, 'server.key'),
        '-out',
        certificate,
      ]);
      chmodSync(join(certs, 'server.key'), 0o644);
      chmodSync(certificate, 0o644);
      wrongCertificate = join(certs, 'other-ca.crt');
      command('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=Unrelated CI CA',
        '-keyout',
        join(certs, 'other-ca.key'),
        '-out',
        wrongCertificate,
      ]);
      command('docker', [
        'run',
        '--detach',
        '--name',
        container,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_PASSWORD=ci-runtime-admin',
        '--volume',
        certs + ':/certs:ro',
        '--entrypoint',
        'sh',
        'postgres:17-alpine',
        '-c',
        `cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key${performanceEnabled ? ' -c shared_preload_libraries=pg_stat_statements' : ''}`,
      ]);
      try {
        await until(ready);
      } catch (error) {
        throw new Error(
          `Disposable PostgreSQL did not become ready: ${String(error)}\n${startupDiagnostics(container)}`,
        );
      }
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        "CREATE ROLE catalog_app LOGIN PASSWORD 'ci-runtime-password'; CREATE ROLE po_catalog_owner NOLOGIN; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; REVOKE ALL ON SCHEMA catalog FROM PUBLIC; GRANT USAGE ON SCHEMA catalog TO catalog_app; ALTER ROLE catalog_app SET default_transaction_read_only = on; SET ROLE po_catalog_owner;\n" +
          readFileSync(
            resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
            'utf8',
          ) +
          '\n' +
          readFileSync(
            resolve(
              'apps/catalog-svc/migrations/0003_product_publication_history.sql',
            ),
            'utf8',
          ),
      );
      if (performanceEnabled)
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          'CREATE EXTENSION pg_stat_statements;',
        );
      databasePort = command('docker', ['port', container, '5432/tcp'])
        .split(':')
        .at(-1)!;
    }, 180000);

    afterAll(() => {
      spawnSync('docker', ['rm', '--force', container], {
        timeout: 15000,
        windowsHide: true,
        stdio: 'ignore',
      });
      if (directory) {
        const withinTemp = relative(tmpdir(), directory);
        if (
          !withinTemp ||
          withinTemp.startsWith('..') ||
          isAbsolute(withinTemp)
        )
          throw new Error('Invalid test cleanup path');
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30000);

    function environment(
      mode: string,
      port: number,
      readDemo = false,
    ): NodeJS.ProcessEnv {
      const clean = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(PG|G6_|DATABASE_URL|CATALOG_)/i.test(key),
        ),
      );
      return {
        ...clean,
        NODE_ENV: 'test',
        CATALOG_SVC_PORT: String(port),
        CATALOG_SVC_HOST: '127.0.0.1',
        CATALOG_AMQP_ENABLED: 'false',
        G6_SECURITY_MODE: readDemo ? 'PUBLIC_READ_ONLY' : 'G7_AUTHENTICATED',
        CATALOG_PUBLIC_OPERATION_IDS: readDemo ? 'listarProductos' : '',
        PGHOST: 'localhost',
        G6_CONNECT_HOST: '127.0.0.1',
        PGPORT: databasePort,
        PGDATABASE: 'postgres',
        PGUSER: 'catalog_app',
        PGPASSWORD: 'ci-runtime-password',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: certificate,
        G6_DATABASE_SCHEMA: 'catalog',
        G6_EXPECTED_ROLE: 'catalog_app',
        G6_CONNECTION_MODE: mode,
      };
    }

    async function stop(child: ChildProcess): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      try {
        await until(
          () => child.exitCode !== null || child.signalCode !== null,
          5000,
        );
      } catch {
        child.kill('SIGKILL');
      }
    }

    it.each(['session', 'direct'])(
      'starts %s, verifies TLS/identity and keeps liveness during DB loss',
      async (mode) => {
        const port = await freePort();
        const child = spawn(process.execPath, [main], {
          cwd: directory,
          env: environment(mode, port),
          windowsHide: true,
        });
        let logs = '';
        child.stdout?.on('data', (data) => {
          logs += String(data);
        });
        child.stderr?.on('data', (data) => {
          logs += String(data);
        });
        let stopped = false;
        try {
          await until(() => {
            if (child.exitCode !== null)
              throw new Error('Catalog exited before positive startup');
            return logs.includes('APPLICATION_STARTED');
          });
          const base = 'http://127.0.0.1:' + port;
          expect((await fetch(base + '/health/live')).status).toBe(200);
          // The official empty schema is sufficient for global eligibility.
          // No candidate table, Pricing/Inventory fan-out or fixture rows.
          expect((await fetch(base + '/health/ready')).status).toBe(200);
          command('docker', ['stop', '--time', '0', container]);
          stopped = true;
          expect((await fetch(base + '/health/live')).status).toBe(200);
          const unavailable = await fetch(base + '/health/ready', {
            signal: AbortSignal.timeout(5000),
          });
          expect(unavailable.status).toBe(503);
          expect(await unavailable.json()).toMatchObject({
            code: 'SERVICIO_NO_DISPONIBLE',
          });
          expect(logs).not.toContain('ci-runtime-password');
        } finally {
          await stop(child);
          if (stopped) {
            command('docker', ['start', container]);
            await until(ready);
            // Docker can allocate a new ephemeral host port when restarting.
            databasePort = command('docker', ['port', container, '5432/tcp'])
              .split(':')
              .at(-1)!;
          }
        }
      },
      60000,
    );

    it('uses PUBLIC_READ_ONLY readiness in HTTP and CLI, and fails closed on missing privileges or relations', async () => {
      const port = await freePort();
      const env = environment('session', port, true);
      const child = spawn(process.execPath, [main], {
        cwd: directory,
        env,
        windowsHide: true,
      });
      let logs = '';
      child.stdout?.on('data', (data) => (logs += String(data)));
      child.stderr?.on('data', (data) => (logs += String(data)));
      try {
        await until(() => {
          if (child.exitCode !== null)
            throw new Error('Catalog demo exited before positive startup');
          return logs.includes('APPLICATION_STARTED');
        });
        const base = 'http://127.0.0.1:' + port;
        expect((await fetch(base + '/health')).status).toBe(200);
        expect((await fetch(base + '/health/live')).status).toBe(200);

        const latencies: number[] = [];
        for (let index = 0; index < 10; index++) {
          const started = performance.now();
          const response = await fetch(base + '/health/ready');
          latencies.push(performance.now() - started);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ status: 'ready' });
          expect(latencies.at(-1)).toBeLessThan(2000);
        }

        const commercial = await fetch(
          base +
            '/api/v1/productos?canal=MARKETPLACE&pagina=1&tamanio=1&orden=NOMBRE_ASC',
        );
        expect(commercial.status).toBe(200);
        expect(await commercial.json()).toMatchObject({
          items: [],
          pagina: 1,
          tamanio: 1,
        });

        const cli = spawnSync(
          process.execPath,
          [resolve('dist/apps/catalog-svc/readiness.js')],
          {
            cwd: directory,
            env,
            encoding: 'utf8',
            timeout: 15000,
            windowsHide: true,
          },
        );
        expect(cli.error).toBeUndefined();
        expect(cli.status).toBe(0);
        expect(JSON.parse(cli.stdout)).toMatchObject({
          service: 'catalog-svc',
          status: 'ready',
          database: 'ready',
          catalogRead: 'ready',
        });

        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          'REVOKE SELECT ON catalog.product_attribute_values FROM catalog_app;',
        );
        expect((await fetch(base + '/health/ready')).status).toBe(503);
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          'GRANT SELECT ON catalog.product_attribute_values TO catalog_app;',
        );
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          'ALTER TABLE catalog.variant_images RENAME TO variant_images_missing;',
        );
        try {
          expect((await fetch(base + '/health/ready')).status).toBe(503);
          const cliUnavailable = spawnSync(
            process.execPath,
            [resolve('dist/apps/catalog-svc/readiness.js')],
            {
              cwd: directory,
              env,
              encoding: 'utf8',
              timeout: 15000,
              windowsHide: true,
            },
          );
          expect(cliUnavailable.error).toBeUndefined();
          expect(cliUnavailable.status).toBe(1);
          expect(JSON.parse(cliUnavailable.stdout)).toMatchObject({
            service: 'catalog-svc',
            status: 'not_ready',
            database: 'ready',
          });
        } finally {
          command(
            'docker',
            [
              'exec',
              '-i',
              container,
              'psql',
              '-U',
              'postgres',
              '-v',
              'ON_ERROR_STOP=1',
            ],
            'ALTER TABLE catalog.variant_images_missing RENAME TO variant_images;',
          );
        }
        expect((await fetch(base + '/health/ready')).status).toBe(200);

        command('docker', ['stop', '--time', '0', container]);
        try {
          const unavailable = await fetch(base + '/health/ready', {
            signal: AbortSignal.timeout(5000),
          });
          expect(unavailable.status).toBe(503);
        } finally {
          command('docker', ['start', container]);
          await until(ready);
          databasePort = command('docker', ['port', container, '5432/tcp'])
            .split(':')
            .at(-1)!;
        }

        await stop(child);
        const restartPort = await freePort();
        const restartedEnv = {
          ...env,
          CATALOG_SVC_PORT: String(restartPort),
          PGPORT: databasePort,
        };
        const restarted = spawn(process.execPath, [main], {
          cwd: directory,
          env: restartedEnv,
          windowsHide: true,
        });
        let restartedLogs = '';
        restarted.stdout?.on('data', (data) => (restartedLogs += String(data)));
        restarted.stderr?.on('data', (data) => (restartedLogs += String(data)));
        try {
          await until(() => restartedLogs.includes('APPLICATION_STARTED'));
          expect(
            (await fetch(`http://127.0.0.1:${restartPort}/health/ready`))
              .status,
          ).toBe(200);
        } finally {
          await stop(restarted);
        }
      } finally {
        await stop(child);
      }
    }, 90000);

    it.skipIf(!performanceEnabled)(
      'mide listado administrativo HTTP con 1000 productos sintéticos en PostgreSQL TLS',
      async () => {
        const productCount = 1000;
        command(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          `SET ROLE po_catalog_owner;
          INSERT INTO catalog.products (nombre, descripcion, categoria_id, tipo_producto_id, marca_id, sku_base, slug, tiene_variantes)
          SELECT 'Benchmark product ' || lpad(i::text, 4, '0'), 'Synthetic isolated performance fixture', 'benchmark-category', 'benchmark-type', 'benchmark-brand', 'G6-PERF-' || lpad(i::text, 4, '0'), 'g6-perf-' || lpad(i::text, 4, '0'), false
          FROM generate_series(1, ${productCount}) AS i;`,
        );

        const port = await freePort();
        const issuer = createJwtFixture({ kid: 'catalog-performance-fixture' });
        const identity = await issuer.listenLocalOnly('127.0.0.1', 0);
        const child = spawn(process.execPath, [main], {
          cwd: directory,
          env: {
            ...environment('session', port),
            G6_SECURITY_MODE: 'SIMULATED_AUTH',
            SIMULATED_AUTH_ISSUER: identity.issuer,
            SIMULATED_AUTH_JWKS_URL: identity.jwksUrl,
          },
          windowsHide: true,
        });
        let logs = '';
        child.stdout?.on('data', (data) => (logs += String(data)));
        child.stderr?.on('data', (data) => (logs += String(data)));
        const outputVariant = process.env.G6_PERFORMANCE_VARIANT ?? 'candidate';
        const token = issuer.mintProfile({
          issuer: identity.issuer,
          profile: 'user-gestor',
        });
        const path = '/api/v1/productos/administracion?pagina=1&tamanio=20';
        const url = `http://127.0.0.1:${port}${path}`;
        const rows: Array<Record<string, number | string>> = [];
        let failures = 0;
        let timeouts = 0;
        let recovery: Record<string, number | boolean> = {};
        let recoveryChild: ChildProcess | undefined;
        const pgStats = (query: string) =>
          command(
            'docker',
            [
              'exec',
              '-i',
              container,
              'psql',
              '-U',
              'postgres',
              '-v',
              'ON_ERROR_STOP=1',
              '-At',
              '-F',
              ',',
            ],
            query,
          );
        const explainPlans = {
          count: pgStats(
            'EXPLAIN (FORMAT JSON) SELECT count(*) FROM catalog.products;',
          ),
          page: pgStats(
            'EXPLAIN (FORMAT JSON) SELECT id, nombre, descripcion, categoria_id, tipo_producto_id, marca_id, sku_base, slug, tiene_variantes, estado, catalog_version, publicado_alguna_vez, created_at, updated_at FROM catalog.products ORDER BY nombre ASC, id ASC LIMIT 20 OFFSET 0;',
          ),
        };

        try {
          try {
            await until(() => {
              if (child.exitCode !== null)
                throw new Error(
                  'Catalog benchmark process exited before readiness',
                );
              return logs.includes('APPLICATION_STARTED');
            });
          } catch (error) {
            throw new Error(
              `Catalog process did not become ready: ${String(error)}\n${startupDiagnostics(container, logs)}`,
            );
          }
          const warmup = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          });
          expect(warmup.status).toBe(200);
          const warmupBody = await warmup.json();
          expect(warmupBody.meta.total).toBe(productCount);

          const warmupRequests = 10;
          const samplesPerLevel = 120;
          for (const concurrency of [1, 8, 32] as const) {
            for (let index = 0; index < warmupRequests; index += 1) {
              const response = await fetch(url, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(5000),
              });
              await response.arrayBuffer();
              if (!response.ok)
                throw new Error(`Catalog warmup HTTP ${response.status}`);
            }
            pgStats('SELECT pg_stat_statements_reset();');
            const latencies: number[] = [];
            let responseBodyBytes = 0;
            let levelFailures = 0;
            let levelTimeouts = 0;
            const started = performance.now();
            for (
              let offset = 0;
              offset < samplesPerLevel;
              offset += concurrency
            ) {
              await Promise.all(
                Array.from(
                  { length: Math.min(concurrency, samplesPerLevel - offset) },
                  async () => {
                    const requestStarted = performance.now();
                    try {
                      const response = await fetch(url, {
                        headers: { authorization: `Bearer ${token}` },
                        signal: AbortSignal.timeout(5000),
                      });
                      const body = await response.arrayBuffer();
                      responseBodyBytes += body.byteLength;
                      if (!response.ok) {
                        failures += 1;
                        levelFailures += 1;
                      }
                    } catch (error) {
                      failures += 1;
                      levelFailures += 1;
                      if (
                        error instanceof DOMException &&
                        error.name === 'TimeoutError'
                      ) {
                        timeouts += 1;
                        levelTimeouts += 1;
                      }
                    } finally {
                      latencies.push(performance.now() - requestStarted);
                    }
                  },
                ),
              );
            }
            const durationMs = performance.now() - started;
            const [sqlCalls, sharedBlocksHit, sharedBlocksRead] = pgStats(
              `SELECT COALESCE(sum(calls),0)::bigint, COALESCE(sum(shared_blks_hit),0)::bigint, COALESCE(sum(shared_blks_read),0)::bigint FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%';`,
            )
              .split(',')
              .map(Number);
            const [poolConnectionsObserved, activeConnectionsObserved] =
              pgStats(
                `SELECT count(*)::int, count(*) FILTER (WHERE state='active')::int FROM pg_stat_activity WHERE usename='catalog_app';`,
              )
                .split(',')
                .map(Number);
            rows.push({
              service: 'Catalog',
              endpoint: `GET ${path}`,
              evidenceClass: 'HTTP_PROCESS_BENCHMARK',
              variant: outputVariant,
              concurrency,
              warmupRequests,
              samples: samplesPerLevel,
              datasetProducts: productCount,
              p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
              p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
              p99Ms: Number(percentile(latencies, 0.99).toFixed(3)),
              throughputRequestsPerSecond: Number(
                ((samplesPerLevel * 1000) / durationMs).toFixed(2),
              ),
              durationMs: Number(durationMs.toFixed(3)),
              requestUrlBytes:
                Buffer.byteLength(new URL(url).pathname + new URL(url).search) *
                samplesPerLevel,
              requestBodyBytes: 0,
              responseBodyBytes,
              sqlCalls: sqlCalls ?? 0,
              sharedBlocksHit: sharedBlocksHit ?? 0,
              sharedBlocksRead: sharedBlocksRead ?? 0,
              poolConnectionsObservedAfter: poolConnectionsObserved ?? 0,
              activeConnectionsObservedAfter: activeConnectionsObserved ?? 0,
              failures: levelFailures,
              timeouts: levelTimeouts,
              bearer: 'RS256 signed SIMULATED_AUTH user with GESTOR_COMERCIAL',
              database: 'PostgreSQL 17 TLS disposable Docker container',
              sqlInstrumentation:
                'pg_stat_statements aggregate counters reset per concurrency level',
            });
          }

          command('docker', ['stop', '--time', '0', container]);
          const unavailable = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          });
          await unavailable.arrayBuffer();
          expect(unavailable.status).toBe(503);
          command('docker', ['start', container]);
          await until(ready, 30000);
          const postgresReadyAfterRestart = ready();
          expect(postgresReadyAfterRestart).toBe(true);
          const previousDatabasePort = databasePort;
          databasePort = command('docker', ['port', container, '5432/tcp'])
            .split(':')
            .at(-1)!;
          const healthUrl = `http://127.0.0.1:${port}/health/ready`;
          let healthBeforeProcessRestart = -1;
          try {
            const healthResponse = await fetch(healthUrl, {
              signal: AbortSignal.timeout(5000),
            });
            healthBeforeProcessRestart = healthResponse.status;
            await healthResponse.arrayBuffer();
          } catch {
            // The mapped host port can change across a Docker stop/start.
          }
          let automaticRecovery = healthBeforeProcessRestart === 200;
          if (!automaticRecovery && databasePort === previousDatabasePort) {
            try {
              await until(async () => {
                try {
                  return (
                    (
                      await fetch(healthUrl, {
                        signal: AbortSignal.timeout(500),
                      })
                    ).status === 200
                  );
                } catch {
                  return false;
                }
              }, 10000);
              automaticRecovery = true;
            } catch {
              automaticRecovery = false;
            }
          }
          const processRestarted = !automaticRecovery;
          if (processRestarted) {
            await stop(child);
            recoveryChild = spawn(process.execPath, [main], {
              cwd: directory,
              env: {
                ...environment('session', port),
                G6_SECURITY_MODE: 'SIMULATED_AUTH',
                SIMULATED_AUTH_ISSUER: identity.issuer,
                SIMULATED_AUTH_JWKS_URL: identity.jwksUrl,
              },
              windowsHide: true,
            });
            let recoveryLogs = '';
            recoveryChild.stdout?.on(
              'data',
              (data) => (recoveryLogs += String(data)),
            );
            recoveryChild.stderr?.on(
              'data',
              (data) => (recoveryLogs += String(data)),
            );
            try {
              await until(() => {
                if (recoveryChild?.exitCode !== null)
                  throw new Error(
                    'Catalog recovery child exited before readiness',
                  );
                return recoveryLogs.includes('APPLICATION_STARTED');
              }, 30000);
            } catch (error) {
              throw new Error(
                `Catalog failed to recover after PG was ready; child restart failed: ${String(error)}\n${startupDiagnostics(container, recoveryLogs)}`,
              );
            }
          }
          const restored = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          });
          const restoredBody = await restored.json();
          expect(restored.status).toBe(200);
          expect(restoredBody.meta.total).toBe(productCount);
          recovery = {
            databaseDownHttpStatus: unavailable.status,
            postgresReadyAfterRestart,
            databasePortChanged: databasePort !== previousDatabasePort,
            catalogHealthBeforeProcessRestart: healthBeforeProcessRestart,
            automaticPoolRecovery: automaticRecovery,
            catalogProcessRestarted: processRestarted,
            healthReadyAfterRestart: true,
            requestRecoveredAfterRestart: true,
          };

          await mkdir(performanceOutput, { recursive: true });
          const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim();
          const report = {
            schemaVersion: 1,
            benchmark: 'catalog-admin-list-http',
            sha,
            variant: outputVariant,
            processTopology: {
              catalog: 'compiled Nest HTTP child process',
              database: 'PostgreSQL 17 TLS disposable Docker container',
              rabbitMq: 'disabled; not required by this read path',
              signedIssuer:
                'local RS256 JWT/JWKS test fixture; SIMULATED_AUTH only',
            },
            measurement: {
              transport: 'HTTP fetch against Catalog process',
              requestBytes:
                'request-target path and query bytes only; headers excluded',
              responseBytes: 'response body bytes',
              sqlQueryCount:
                'pg_stat_statements aggregate calls per concurrency level',
              buffers:
                'pg_stat_statements shared block hit/read counters per level',
              explainPlans,
              poolOccupancy:
                'post-window pg_stat_activity snapshot; peak/active-time series not instrumented',
              sustainedSamplesPerConcurrency: samplesPerLevel,
            },
            totals: { failures, timeouts },
            recovery,
            results: rows,
          };
          await writeFile(
            resolve(
              performanceOutput,
              `catalog-admin-http-${outputVariant}.json`,
            ),
            `${JSON.stringify(report, null, 2)}\n`,
          );
          const header = Object.keys(rows[0] ?? {})
            .map(csvCell)
            .join(',');
          await writeFile(
            resolve(
              performanceOutput,
              `catalog-admin-http-${outputVariant}.csv`,
            ),
            `${[header, ...rows.map((row) => Object.values(row).map(csvCell).join(','))].join('\n')}\n`,
          );
          expect(failures).toBe(0);
          expect(timeouts).toBe(0);
        } finally {
          await stop(recoveryChild);
          await stop(child);
          await identity.close();
        }
      },
      180000,
    );

    it.each(['session', 'direct'])(
      'rejects missing identity, an unrelated CA and a mismatched TLS hostname in %s',
      async (mode) => {
        for (const override of [
          { G6_EXPECTED_ROLE: '' },
          { PGSSLROOTCERT: wrongCertificate },
          { PGHOST: 'wrong-host.example.test' },
        ]) {
          const result = spawnSync(process.execPath, [main], {
            cwd: directory,
            env: { ...environment(mode, await freePort()), ...override },
            encoding: 'utf8',
            timeout: 15000,
            windowsHide: true,
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('APPLICATION_START_FAILED');
          expect(result.stdout + result.stderr).not.toContain(
            'ci-runtime-password',
          );
        }
      },
      40000,
    );
  },
);
