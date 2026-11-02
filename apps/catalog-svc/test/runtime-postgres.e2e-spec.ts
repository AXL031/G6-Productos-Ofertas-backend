import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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

// Both modes use a real disposable PostgreSQL TLS server. No Supabase credentials,
// replacements for Database, commercial fixtures, or runtime mocks are involved.
const dockerAvailable =
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).status === 0;

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
        'cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key',
      ]);
      await until(ready);
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

    function environment(mode: string, port: number): NodeJS.ProcessEnv {
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
