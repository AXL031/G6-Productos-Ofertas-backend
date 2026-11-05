import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCombosEnvironment } from './combos-environment.js';

describe('readCombosEnvironment', () => {
  let directory: string;
  let caPath: string;
  const cert =
    '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';
  const base = (): NodeJS.ProcessEnv => ({
    COMBOS_SVC_PORT: '3007',
    COMBOS_SVC_HOST: '127.0.0.1',
    SECURITY_ISSUER: 'https://identity.example',
    SECURITY_DISCOVERY_URL:
      'https://identity.example/.well-known/openid-configuration',
    SECURITY_JWKS_URL: 'https://identity.example/jwks',
    PGHOST: 'localhost',
    PGPORT: '5432',
    PGDATABASE: 'combos_test',
    PGUSER: 'combos_app',
    PGPASSWORD: 'private-fixture',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: caPath,
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'g6-combos-config-'));
    caPath = join(directory, 'ca.pem');
    writeFileSync(caPath, cert);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('parses host/port and builds strict TLS verify-full settings', () => {
    const config = readCombosEnvironment(base());
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3007,
      demoEnabled: false,
    });
    expect(config.pool).toMatchObject({
      host: 'localhost',
      port: 5432,
      database: 'combos_test',
      user: 'combos_app',
      ssl: { rejectUnauthorized: true, servername: 'localhost', ca: cert },
    });
  });
  it('fails closed for missing or malformed configuration without echoing credentials', () => {
    const env = base();
    delete env.PGPASSWORD;
    expect(() => readCombosEnvironment(env)).toThrow(/PGPASSWORD/);
    expect(() =>
      readCombosEnvironment({ ...base(), PGSSLMODE: 'disable' }),
    ).toThrow(/PGSSLMODE/);
    expect(() =>
      readCombosEnvironment({ ...base(), COMBOS_SVC_PORT: '70000' }),
    ).toThrow(/COMBOS_SVC_PORT/);
    expect(() =>
      readCombosEnvironment({ ...base(), PGSSLROOTCERT: 'relative.pem' }),
    ).toThrow(/PGSSLROOTCERT/);
  });
  it('rejects test-only identity bypass flags outside the test runtime', () => {
    expect(() =>
      readCombosEnvironment({
        ...base(),
        NODE_ENV: 'production',
        COMBOS_TEST_EPHEMERAL: '1',
      }),
    ).toThrow(/COMBOS_TEST_EPHEMERAL/);
    expect(() =>
      readCombosEnvironment({ ...base(), COMBOS_TEST_EPHEMERAL: 'true' }),
    ).toThrow(/COMBOS_TEST_EPHEMERAL/);
    expect(
      readCombosEnvironment({
        ...base(),
        NODE_ENV: 'test',
        COMBOS_TEST_EPHEMERAL: '1',
      }).securityMode,
    ).toBe('G7_AUTHENTICATED');
  });
  it('keeps restricted demo off by default and requires explicit perimeter confirmation', () => {
    expect(readCombosEnvironment(base()).demoEnabled).toBe(false);
    expect(() =>
      readCombosEnvironment({
        ...base(),
        COMBOS_RESTRICTED_DEMO_ENABLED: 'true',
      }),
    ).toThrow(/COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED/);
    expect(() =>
      readCombosEnvironment({
        ...base(),
        COMBOS_RESTRICTED_DEMO_ENABLED: 'true',
        COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED: 'true',
      }),
    ).toThrow(/COMBOS_RESTRICTED_DEMO_GATEWAY_IPS/);
    expect(
      readCombosEnvironment({
        ...base(),
        COMBOS_RESTRICTED_DEMO_ENABLED: 'true',
        COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED: 'true',
        COMBOS_RESTRICTED_DEMO_GATEWAY_IPS: '127.0.0.1, ::1',
      }),
    ).toMatchObject({
      demoEnabled: true,
      demoGatewayIps: ['127.0.0.1', '::1'],
    });
    expect(() =>
      readCombosEnvironment({
        ...base(),
        COMBOS_RESTRICTED_DEMO_GATEWAY_IPS: 'trusted.invalid',
      }),
    ).toThrow(/COMBOS_RESTRICTED_DEMO_GATEWAY_IPS/);
  });

  it('rejects invalid AMQP flags and partial M2M identity configuration', () => {
    expect(() =>
      readCombosEnvironment({ ...base(), COMBOS_AMQP_ENABLED: 'yes' }),
    ).toThrow(/COMBOS_AMQP_ENABLED/);
    expect(() =>
      readCombosEnvironment({
        ...base(),
        COMBOS_AMQP_ENABLED: 'true',
        COMBOS_AMQP_URL: 'amqp://guest:guest@localhost:5672/',
      }),
    ).toThrow(/COMBOS_AMQP_URL/);
    expect(() =>
      readCombosEnvironment({
        ...base(),
        COMBOS_G7_TOKEN_URL: 'https://identity.example/token',
      }),
    ).toThrow(/COMBOS_G7_TOKEN_URL/);
  });

  it('validates private upstream URLs and complete identity discovery configuration', () => {
    expect(() =>
      readCombosEnvironment({
        ...base(),
        COMBOS_CATALOG_URL: 'https://catalog.example',
        COMBOS_PRICING_URL: 'http://evil.example',
      }),
    ).toThrow(/COMBOS_PRICING_URL/);
    const partialIdentity = base();
    delete partialIdentity.SECURITY_DISCOVERY_URL;
    delete partialIdentity.SECURITY_JWKS_URL;
    expect(() =>
      readCombosEnvironment({
        ...partialIdentity,
        SECURITY_ISSUER: 'https://identity.example',
      }),
    ).toThrow(/SECURITY_ISSUER/);
  });

  it('validates progressive security mode and independent simulated issuer configuration', () => {
    expect(readCombosEnvironment(base()).securityMode).toBe('G7_AUTHENTICATED');
    expect(() =>
      readCombosEnvironment({ ...base(), G6_SECURITY_MODE: 'DEMO' }),
    ).toThrow(/G6_SECURITY_MODE/);
    expect(() =>
      readCombosEnvironment({ ...base(), G6_SECURITY_MODE: 'SIMULATED_AUTH' }),
    ).toThrow(/COMBOS_SIMULATED_ISSUER/);
    const simulated = {
      ...base(),
      G6_SECURITY_MODE: 'SIMULATED_AUTH',
      COMBOS_SIMULATED_ISSUER: 'https://demo.example',
      COMBOS_SIMULATED_DISCOVERY_URL:
        'https://demo.example/.well-known/openid-configuration',
      COMBOS_SIMULATED_JWKS_URL: 'https://demo.example/jwks',
    };
    expect(readCombosEnvironment(simulated).securityMode).toBe(
      'SIMULATED_AUTH',
    );
    expect(() =>
      readCombosEnvironment({
        ...simulated,
        COMBOS_SIMULATED_ISSUER: 'https://identity.example',
      }),
    ).toThrow(/independent from G7/);
  });
});
