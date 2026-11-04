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
});
