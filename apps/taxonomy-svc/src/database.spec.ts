import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, readDatabaseConfig, parseDatabaseUrl } from './database.js';

describe('taxonomy PostgreSQL configuration and lifecycle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g6-taxonomy-'));
  const ca = join(directory, 'ca.crt');
  const env = {
    PGHOST: 'db.example.test',
    PGPORT: '5432',
    PGDATABASE: 'postgres',
    PGUSER: 'taxonomy_dev_login.project',
    PGPASSWORD: 'only-a-test-password',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: ca,
    G6_DATABASE_SCHEMA: 'taxonomy',
    G6_EXPECTED_ROLE: 'taxonomy_dev_login',
    G6_CONNECTION_MODE: 'session',
  };
  beforeAll(() =>
    writeFileSync(
      ca,
      '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----',
    ),
  );
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());
  it('uses CA, strict TLS, hostname and bounded pool', () => {
    const config = readDatabaseConfig({ ...env, G6_CONNECT_HOST: '127.0.0.2' });
    expect(config.host).toBe('127.0.0.2');
    expect(config.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.example.test',
    });
    expect(config.max).toBe(4);
    expect(config.connectionTimeoutMillis).toBe(10000);
  });
  it.each(Object.keys(env))(
    'rejects missing %s without leaking values',
    (key) => {
      expect(() => readDatabaseConfig({ ...env, [key]: '' })).toThrow(
        'Configuración PostgreSQL taxonomy inválida',
      );
    },
  );
  it.each([
    { PGSSLMODE: 'require' },
    { PGPORT: '0' },
    { PGPORT: '65536' },
    { PGPORT: '1x' },
    { G6_DATABASE_SCHEMA: 'other' },
    { G6_EXPECTED_ROLE: 'postgres', PGUSER: 'postgres' },
    { PGUSER: 'other_dev_login' },
    { G6_CONNECTION_MODE: 'transaction' },
    { PGSSLROOTCERT: 'relative.crt' },
  ])('rejects unsafe configuration %j', (override) => {
    expect(() => readDatabaseConfig({ ...env, ...override })).toThrow(
      'Configuración PostgreSQL taxonomy inválida',
    );
  });
  it('closes pool and rejects use after shutdown', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const database = new Database();
    expect(await database.read(async () => 'no-connection-opened')).toBe(
      'no-connection-opened',
    );
    await database.onModuleDestroy();
    await expect(database.read(async () => true)).rejects.toMatchObject({
      status: 503,
    });
    await expect(database.verifyIdentity()).rejects.toMatchObject({
      status: 503,
      message: 'Servicio temporalmente no disponible',
    });
  });
  it('sanitizes driver/callback failures', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const database = new Database();
    const logger = { error: vi.fn() };
    database.usarLogger(logger);
    try {
      await expect(
        database.read(async () => {
          throw new Error('private-password SELECT query');
        }),
      ).rejects.toMatchObject({
        status: 503,
        message: 'Servicio temporalmente no disponible',
      });
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({
        event: 'taxonomy.database.query_failed',
        service: 'taxonomy-svc',
        component: 'postgres',
        state: 'unavailable',
        reason: 'POSTGRES_QUERY_FAILURE',
      });
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
        'private-password',
      );
    } finally {
      await database.onModuleDestroy();
    }
  });
  it('parses DATABASE_URL and enforces strict TLS and identity checks', () => {
    const dbUrl = `postgresql://taxonomy_dev_login.project:only-a-test-password@db.example.test:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}&currentSchema=taxonomy`;
    const config = readDatabaseConfig({
      DATABASE_URL: dbUrl,
      G6_EXPECTED_ROLE: 'taxonomy_dev_login',
      G6_CONNECTION_MODE: 'session',
    });
    expect(config.host).toBe('db.example.test');
    expect(config.port).toBe(5432);
    expect(config.database).toBe('postgres');
    expect(config.user).toBe('taxonomy_dev_login.project');
    expect(config.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.example.test',
    });
  });
  it.each([
    'postgresql://taxonomy_dev_login.project:pass@db.example.test:5432/postgres?sslmode=disable',
    'postgresql://postgres:pass@db.example.test:5432/postgres?sslmode=verify-full',
    'postgresql://taxonomy_dev_login.project:pass@db.example.test:5432/postgres?sslmode=verify-full&sslrootcert=relative.crt',
    'postgresql://taxonomy_dev_login.project:pass@db.example.test:5432/postgres?sslmode=verify-full&currentSchema=public',
    'not-a-valid-url',
  ])('rejects insecure or non-compliant DATABASE_URL %s', (invalidUrl) => {
    expect(() =>
      readDatabaseConfig({
        DATABASE_URL: invalidUrl,
        G6_EXPECTED_ROLE: 'taxonomy_dev_login',
        G6_CONNECTION_MODE: 'session',
        G6_DATABASE_SCHEMA: 'taxonomy',
        PGSSLROOTCERT: ca,
        PGSSLMODE: 'verify-full',
      }),
    ).toThrow('Configuración PostgreSQL taxonomy inválida');
  });
  it('handles invalid URL safely in parseDatabaseUrl without throwing', () => {
    expect(parseDatabaseUrl(':::not-a-url:::')).toEqual({});
  });
});
