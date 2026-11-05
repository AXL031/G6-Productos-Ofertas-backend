import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

/** Always creates its own database. No supplied URL or shared environment is read. */
export class Phase1Postgres {
  readonly name = 'g6-phase1-' + randomUUID();
  readonly password = randomUUID();
  directory = '';
  certificate = '';
  key = '';
  port = '';
  private created = false;

  private command(bin: string, args: string[], input?: string): string {
    const result = spawnSync(bin, args, {
      input,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Isolated Phase 1 ${args[0]} failed: ${String(result.stderr).replaceAll(this.password, '[redacted]').slice(-1500)}`,
      );
    return result.stdout.trim();
  }

  sql(query: string): string {
    if (!this.created) throw new Error('Isolated PostgreSQL was not created');
    return this.command(
      'docker',
      [
        'exec',
        '-i',
        this.name,
        'psql',
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-At',
      ],
      query,
    );
  }

  async start(): Promise<void> {
    this.directory = mkdtempSync(join(tmpdir(), 'g6-phase1-'));
    this.certificate = join(this.directory, 'server.crt');
    this.key = join(this.directory, 'server.key');
    const openssl =
      process.env.G6_TEST_OPENSSL ??
      [
        join(
          process.env.LOCALAPPDATA ?? '',
          'Programs/Git/usr/bin/openssl.exe',
        ),
        'C:/Program Files/Git/usr/bin/openssl.exe',
      ].find(existsSync) ??
      'openssl';
    this.command(openssl, [
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
      this.key,
      '-out',
      this.certificate,
    ]);
    this.command('docker', [
      'run',
      '--detach',
      '--name',
      this.name,
      '--label',
      'g6.phase1.session=' + this.name,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD=' + this.password,
      '--volume',
      this.directory + ':/certs:ro',
      '--entrypoint',
      'sh',
      'postgres:17-alpine',
      '-c',
      'cp /certs/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key',
    ]);
    this.created = true;
    const deadline = Date.now() + 30000;
    for (;;) {
      const ready =
        spawnSync(
          'docker',
          ['exec', this.name, 'pg_isready', '-U', 'postgres'],
          { windowsHide: true, timeout: 3000, stdio: 'ignore' },
        ).status === 0;
      if (ready) break;
      if (Date.now() >= deadline)
        throw new Error('Isolated PostgreSQL startup timed out');
      await pause(200);
    }
    const mapping = this.command('docker', ['port', this.name, '5432/tcp']);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    if (!port) throw new Error('PostgreSQL must only publish to loopback');
    this.port = port;
    this.sql(`CREATE ROLE po_catalog_owner NOLOGIN;
      CREATE ROLE catalog_app LOGIN PASSWORD '${this.password}';
      CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;
      CREATE ROLE po_taxonomy_owner NOLOGIN;
      CREATE ROLE taxonomy_app LOGIN PASSWORD '${this.password}';
      CREATE SCHEMA taxonomy AUTHORIZATION po_taxonomy_owner;
      SET ROLE po_catalog_owner;
      ${readFileSync(resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'), 'utf8')}
      ${readFileSync(resolve('apps/catalog-svc/migrations/0002_create_sku_barcodes.sql'), 'utf8')}
      ${readFileSync(resolve('apps/catalog-svc/migrations/0003_product_publication_history.sql'), 'utf8')}
      RESET ROLE; SET ROLE po_taxonomy_owner;
      ${readFileSync(resolve('apps/api-gateway/test/fixtures/phase1-taxonomy-0001.sql'), 'utf8')}
      RESET ROLE;`);
    // Frozen official taxonomy migration: Docs a7778ec1, Git blob
    // 3db51993e6c06ecfcbc2e93f6757f848a78987f4. Only the disposable DB is migrated.
  }

  env(service: 'catalog' | 'taxonomy'): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      PGHOST: 'localhost',
      G6_CONNECT_HOST: '127.0.0.1',
      PGPORT: this.port,
      PGDATABASE: 'postgres',
      PGUSER: service + '_app',
      PGPASSWORD: this.password,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: this.certificate,
      G6_DATABASE_SCHEMA: service,
      G6_EXPECTED_ROLE: service + '_app',
      G6_CONNECTION_MODE: 'direct',
    };
  }

  async close(): Promise<void> {
    if (this.created) {
      const label = this.command('docker', [
        'inspect',
        '--format',
        '{{index .Config.Labels "g6.phase1.session"}}',
        this.name,
      ]);
      if (label !== this.name)
        throw new Error('Refusing to remove a foreign container');
      this.command('docker', ['rm', '--force', '--volumes', this.name]);
      this.created = false;
    }
    if (this.directory) {
      const inside = relative(tmpdir(), this.directory);
      if (!inside || inside.startsWith('..') || isAbsolute(inside))
        throw new Error('Unsafe temporary path');
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
