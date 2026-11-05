import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';

const exec = promisify(execFile);
const image =
  'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';

// Solo crea su contenedor; no acepta DATABASE_URL ni un servidor externo.
export class IsolatedPostgres {
  private readonly name = `pricing-53-${randomUUID()}`;
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
        'POSTGRES_DB=pricing_test',
        image,
      ],
      { timeout: 60000 },
    );
    this.created = true;
    const { stdout } = await exec('docker', ['port', this.name, '5432/tcp']);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
    if (!port) throw new Error('Puerto de fixture aislada inválido.');
    const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/pricing_test`;
    this.admin = new Pool({
      connectionString: adminUrl,
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
        await setTimeout(250);
      }
    }
    if (!ready) throw new Error('PostgreSQL aislado no disponible.');
    const source = await readFile(
      new URL('./fixtures/pricing.sql', import.meta.url),
      'utf8',
    );
    const hash = createHash('sha256')
      .update(source.replaceAll('\r\n', '\n'))
      .digest('hex');
    if (
      hash !==
      '7f440ffa401e8d56ecb2664060edb131505a16b8568843093a5047a6c13bc581'
    ) {
      throw new Error('El SQL normativo de la fixture cambió.');
    }
    // Roles/ACL exclusivos de esta instancia descartable; nunca Supabase.
    await this.admin.query(`
      CREATE ROLE po_pricing_owner NOLOGIN;
      CREATE ROLE pricing_app LOGIN PASSWORD '${password}';
      CREATE SCHEMA pricing AUTHORIZATION po_pricing_owner;
      CREATE SCHEMA extensions;
      CREATE EXTENSION btree_gist WITH SCHEMA extensions;
      GRANT USAGE ON SCHEMA extensions TO po_pricing_owner;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      CREATE SCHEMA foreign_fixture;
      CREATE TABLE foreign_fixture.secret (id integer);
      BEGIN; SET LOCAL ROLE po_pricing_owner;
      ${source}
      COMMIT;
    `);
    const scheduleContextMigration = await readFile(
      new URL(
        '../migrations/0002_schedule_effective_events.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await this.admin.query('BEGIN');
    try {
      await this.admin.query(scheduleContextMigration);
      await this.admin.query('COMMIT');
    } catch (error) {
      await this.admin.query('ROLLBACK');
      throw error;
    }
    this.runtimeUrl = `postgresql://pricing_app:${password}@127.0.0.1:${port}/pricing_test`;
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
