import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { Database, readDatabaseConfig } from './database.js';

describe('catalog PostgreSQL configuration and lifecycle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g6-catalog-'));
  const ca = join(directory, 'ca.crt');
  const env = {
    PGHOST: 'db.example.test',
    PGPORT: '5432',
    PGDATABASE: 'postgres',
    PGUSER: 'catalog_dev_login.project',
    PGPASSWORD: 'only-a-test-password',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: ca,
    G6_DATABASE_SCHEMA: 'catalog',
    G6_EXPECTED_ROLE: 'catalog_dev_login',
    G6_CONNECTION_MODE: 'session',
  };
  beforeAll(() =>
    writeFileSync(
      ca,
      '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----',
    ),
  );
  afterAll(() => {
    unlinkSync(ca);
    rmdirSync(directory);
  });
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
  it.each(['session', 'direct'])(
    'accepts %s with the same strict TLS schema',
    (mode) => {
      const user = mode === 'direct' ? 'catalog_app' : env.PGUSER;
      const expectedRole =
        mode === 'direct' ? 'catalog_app' : env.G6_EXPECTED_ROLE;
      expect(
        readDatabaseConfig({
          ...env,
          PGUSER: user,
          G6_EXPECTED_ROLE: expectedRole,
          G6_CONNECTION_MODE: mode,
        }).ssl,
      ).toMatchObject({ rejectUnauthorized: true, servername: env.PGHOST });
    },
  );
  it.each(Object.keys(env))(
    'rejects missing %s without leaking values',
    (key) => {
      expect(() => readDatabaseConfig({ ...env, [key]: '' })).toThrow(
        'Configuración PostgreSQL catalog inválida',
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
      'Configuración PostgreSQL catalog inválida',
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
      failure: 'connection',
    });
  });
  it('preserves domain failures and translates SQLSTATE errors wrapped by Drizzle', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const database = new Database();
    const domainFailure = new BadRequestException('invalid catalog input');
    try {
      await expect(
        database.read(async () => {
          throw domainFailure;
        }),
      ).rejects.toBe(domainFailure);

      const postgresError = Object.assign(
        new Error('private-password SELECT query'),
        { code: '23505', constraint: 'catalog_product_sku_uq' },
      );
      const drizzleError = Object.assign(new Error('Drizzle query failed'), {
        cause: postgresError,
        query: 'INSERT INTO catalog.products',
      });
      const translated = await database
        .read(async () => {
          throw drizzleError;
        })
        .catch((error: unknown) => error);
      expect(translated).toMatchObject({
        failure: 'unique',
        message: 'Falló una operación de persistencia de Catálogo',
      });
      expect(JSON.stringify(translated)).not.toContain('private-password');
      expect(JSON.stringify(translated)).not.toContain('INSERT INTO');
    } finally {
      await database.onModuleDestroy();
    }
  });
});
