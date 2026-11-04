import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, readPostgresSettings } from './database.js';

const driver = vi.hoisted(() => ({
  pool: vi.fn(),
  execute: vi.fn(),
  end: vi.fn(),
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: unknown) {
        driver.pool(options);
      }
      on() {
        return this;
      }
      end = driver.end;
    },
  },
}));
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({ execute: driver.execute }),
}));

const directory = mkdtempSync(join(tmpdir(), 'catalog-identity-'));
const certificate = join(directory, 'fixture.crt');
const env = () => ({
  PGHOST: 'db.example.test',
  G6_CONNECT_HOST: '127.0.0.2',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGUSER: 'catalog_app',
  PGPASSWORD: 'fixture-secret',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: certificate,
  G6_DATABASE_SCHEMA: 'catalog',
  G6_EXPECTED_ROLE: 'catalog_app',
  G6_CONNECTION_MODE: 'direct',
});
const valid = {
  role: 'catalog_app',
  database: 'postgres',
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
  rolcreatedb: false,
  usage: true,
  owner_member: false,
};
beforeAll(() =>
  writeFileSync(
    certificate,
    '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----',
  ),
);
afterAll(() => {
  unlinkSync(certificate);
  rmdirSync(directory);
});

// Migrated from the removed standalone readiness client: identity and outages now
// exercise the production Database pool used by commercial queries and readiness.
describe('Database identity and shared pool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driver.execute.mockResolvedValue({ rows: [valid] });
    driver.end.mockResolvedValue(undefined);
  });

  it('reuses one pool and queries identity on every check with the validated host/TLS', async () => {
    const settings = readPostgresSettings(env());
    const database = new Database(settings);
    try {
      await database.verifyIdentity();
      await database.verifyIdentity();
      expect(driver.pool).toHaveBeenCalledOnce();
      expect(driver.execute).toHaveBeenCalledTimes(2);
      expect(driver.pool).toHaveBeenCalledWith(settings.pool);
      expect(settings.pool.host).toBe('127.0.0.2');
      expect(settings.pool.ssl).toMatchObject({
        servername: 'db.example.test',
        rejectUnauthorized: true,
      });
    } finally {
      await database.onModuleDestroy();
    }
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it.each([
    { ...valid, role: 'taxonomy_app' },
    { ...valid, database: 'other' },
    { ...valid, usage: false },
    { ...valid, rolsuper: true },
    { ...valid, rolbypassrls: true },
    { ...valid, rolcreaterole: true },
    { ...valid, rolcreatedb: true },
    { ...valid, owner_member: true },
    undefined,
  ])('rejects unexpected identity or elevated privileges', async (status) => {
    driver.execute.mockResolvedValue({ rows: status ? [status] : [] });
    const database = new Database(readPostgresSettings(env()));
    try {
      await expect(database.verifyIdentity()).rejects.toMatchObject({
        failure: 'other',
      });
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('does not reuse a prior success or expose driver errors after dependency loss', async () => {
    const database = new Database(readPostgresSettings(env()));
    try {
      await database.verifyIdentity();
      const postgresError = Object.assign(
        new Error('fixture-secret SELECT private'),
        { code: 'ECONNRESET' },
      );
      driver.execute.mockRejectedValueOnce(
        Object.assign(new Error('Drizzle query failed'), {
          cause: postgresError,
          query: 'SELECT private identity data',
        }),
      );
      await expect(database.verifyIdentity()).rejects.toMatchObject({
        failure: 'connection',
        message: 'Falló una operación de persistencia de Catálogo',
      });
      await database.verifyIdentity();
      expect(driver.pool).toHaveBeenCalledOnce();
      expect(driver.execute).toHaveBeenCalledTimes(3);
    } finally {
      await database.onModuleDestroy();
    }
  });
});
