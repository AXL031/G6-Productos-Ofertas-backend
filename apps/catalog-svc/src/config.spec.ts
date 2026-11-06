import { CatalogConfig } from './config.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'catalog-config-'));
const certificate = join(directory, 'fixture.crt');
const validEnv = () => ({
  NODE_ENV: 'test',
  CATALOG_SVC_PORT: '3001',
  PGHOST: 'localhost',
  PGPORT: '5432',
  PGDATABASE: 'postgres',
  PGUSER: 'catalog_app',
  PGPASSWORD: 'fixture-secret',
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: certificate,
  G6_CONNECTION_MODE: 'direct',
  G6_DATABASE_SCHEMA: 'catalog',
  G6_EXPECTED_ROLE: 'catalog_app',
});

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

describe('CatalogConfig PG contract', () => {
  it('captures restricted demo explicitly and rejects public upstreams or mixed preview', () => {
    const env = {
      ...validEnv(),
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      CATALOG_DEMO_GATEWAY_IPS: '10.0.0.5',
      CATALOG_TAXONOMY_URL: 'http://taxonomy-svc:3009',
      CATALOG_PRICING_URL: 'http://pricing-svc:3002',
    };
    expect(new CatalogConfig(env).readDemo.restricted).toBe(true);
    expect(
      new CatalogConfig({ ...env, GATEWAY_DEMO_NO_AUTH_ENABLED: 'false' })
        .readDemo.restricted,
    ).toBeUndefined();
    expect(
      () =>
        new CatalogConfig({
          ...env,
          CATALOG_TAXONOMY_URL: 'https://public.example',
        }),
    ).toThrow();
    expect(
      () =>
        new CatalogConfig({
          ...env,
          CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED: 'true',
        }),
    ).toThrow();
  });
  it('captures messaging and timeout configuration once and rejects malformed settings', () => {
    const config = new CatalogConfig({
      ...validEnv(),
      CATALOG_PREPARATION_TIMEOUT_MS: '60000',
    });
    expect(config.preparation.timeoutMs).toBe(60000);
    expect(config.amqp.connection).toBeUndefined();
    expect(Object.isFrozen(config.preparation)).toBe(true);
    expect(
      () =>
        new CatalogConfig({
          ...validEnv(),
          CATALOG_PREPARATION_TIMEOUT_MS: '-1',
        }),
    ).toThrow();
    expect(
      () =>
        new CatalogConfig({
          ...validEnv(),
          CATALOG_AMQP_ENABLED: 'true',
          RABBITMQ_URL: 'amqp://user:fixture@localhost/',
        }),
    ).toThrow();
  });
  it.each(['session', 'direct'])(
    'accepts %s with strict TLS and typed configuration',
    (mode) => {
      const config = new CatalogConfig({
        ...validEnv(),
        G6_CONNECTION_MODE: mode,
      });
      expect(config.port).toBe(3001);
      expect(config.host).toBe('127.0.0.1');
      expect(config.database).toMatchObject({
        mode,
        expectedRole: 'catalog_app',
        database: 'postgres',
      });
      expect(config.database.pool.ssl).toMatchObject({
        rejectUnauthorized: true,
        servername: 'localhost',
      });
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.database)).toBe(true);
    },
  );

  it('uses PORT only when the service port is absent', () => {
    expect(
      new CatalogConfig({
        ...validEnv(),
        CATALOG_SVC_PORT: undefined,
        PORT: '4000',
      }).port,
    ).toBe(4000);
    expect(new CatalogConfig({ ...validEnv(), PORT: '4000' }).port).toBe(3001);
  });

  it.each(Object.keys(validEnv()))(
    'rejects missing %s before startup',
    (key) => {
      expect(
        () => new CatalogConfig({ ...validEnv(), [key]: undefined }),
      ).toThrow(key);
    },
  );

  it.each(['', '0', '65536', '-1', '3.5', '1e3', '0x100', ' 3001', 'secret'])(
    'rejects malformed port %s',
    (port) => {
      expect(
        () => new CatalogConfig({ ...validEnv(), CATALOG_SVC_PORT: port }),
      ).toThrow('CATALOG_SVC_PORT');
    },
  );

  it.each([
    ['PGSSLMODE', 'disable'],
    ['G6_CONNECTION_MODE', 'transaction'],
    ['G6_DATABASE_SCHEMA', 'taxonomy'],
    ['G6_EXPECTED_ROLE', 'postgres'],
    ['PGUSER', 'taxonomy_app'],
    ['PGPORT', '1e3'],
    ['PGHOST', 'invalid host'],
    ['G6_CONNECT_HOST', 'invalid host'],
    ['PGSSLROOTCERT', 'relative.crt'],
    ['PGSSLROOTCERT', join(tmpdir(), 'catalog-missing-fixture.crt')],
    ['CATALOG_SVC_HOST', 'invalid-host'],
    ['CATALOG_TAXONOMY_URL', 'https://user:private-secret@example.test'],
  ])('rejects invalid %s without exposing values', (key, value) => {
    expect(() => new CatalogConfig({ ...validEnv(), [key]: value })).toThrow(
      key,
    );
  });

  it('does not accept DATABASE_URL instead of the PG schema', () => {
    expect(
      () =>
        new CatalogConfig({
          NODE_ENV: 'test',
          CATALOG_SVC_PORT: '3001',
          DATABASE_URL:
            'postgres://catalog_app:private-secret@localhost/catalog',
        }),
    ).toThrow('PGHOST');
  });

  it('preserves host override and expected role without relying on later environment changes', () => {
    const env = { ...validEnv(), G6_CONNECT_HOST: '127.0.0.2' };
    const config = new CatalogConfig(env);
    env.G6_CONNECT_HOST = '127.0.0.3';
    env.G6_EXPECTED_ROLE = 'catalog_dev_login';
    expect(config.database.pool.host).toBe('127.0.0.2');
    expect(config.database.expectedRole).toBe('catalog_app');
  });

  it('snapshots the validated Taxonomy origin independently of mutable environment', () => {
    const env = {
      ...validEnv(),
      CATALOG_TAXONOMY_URL: 'https://taxonomy.example.test/',
    };
    const config = new CatalogConfig(env);
    env.CATALOG_TAXONOMY_URL = 'http://invalid.example.test';
    expect(config.taxonomy.origin).toBe('https://taxonomy.example.test');
    expect(Object.isFrozen(config.taxonomy)).toBe(true);
  });

  it('keeps demo preview disabled by default and validates its explicit flag and private Pricing origin', () => {
    expect(new CatalogConfig(validEnv()).marketplaceDemoPreview).toBe(false);
    expect(
      () =>
        new CatalogConfig({
          ...validEnv(),
          CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED: 'yes',
        }),
    ).toThrow('CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED');
    expect(
      () =>
        new CatalogConfig({
          ...validEnv(),
          CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED: 'true',
        }),
    ).toThrow('CATALOG_PRICING_URL');
    const config = new CatalogConfig({
      ...validEnv(),
      CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED: 'true',
      CATALOG_PRICING_URL: 'http://pricing-svc:3002',
    });
    expect(config.marketplaceDemoPreview).toBe(true);
    expect(config.pricingOrigin).toBe('http://pricing-svc:3002');
    expect(
      () =>
        new CatalogConfig({
          ...validEnv(),
          CATALOG_PRICING_URL: 'https://pricing.example.test',
        }),
    ).toThrow('CATALOG_PRICING_URL');
  });

  it('rejects an unknown environment and does not echo secret values', () => {
    expect(
      () => new CatalogConfig({ ...validEnv(), NODE_ENV: 'private-secret' }),
    ).toThrow('NODE_ENV');
    try {
      new CatalogConfig({ DATABASE_URL: 'private-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('private-secret');
    }
  });
});
