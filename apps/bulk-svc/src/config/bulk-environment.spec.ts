import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates, checkServerIdentity } from 'node:tls';
import {
  InvalidBulkEnvironment,
  parseBulkEnvironment,
} from './bulk-environment.js';

const valid = {
  NODE_ENV: 'test',
  BULK_SVC_PORT: '3008',
};
const caDirectory = mkdtempSync(join(tmpdir(), 'bulk-ca-'));
const caPath = join(caDirectory, 'bulk-ca.pem');
writeFileSync(caPath, rootCertificates[0]!);
const invalidCaCases: ReadonlyArray<{
  nombre: string;
  path: string;
  contents?: string;
}> = [
  {
    nombre: 'missing',
    path: join(caDirectory, 'missing-ca.pem'),
  },
  {
    nombre: 'invalid',
    path: join(caDirectory, 'invalid-ca.pem'),
    contents: 'not a certificate',
  },
];
const certificateReader = () => rootCertificates[0]!;
const remoteUrl =
  'postgresql://bulk_user:secret-value@db.example.test:5432/postgres';

describe('parseBulkEnvironment', () => {
  afterAll(() => {
    rmSync(caDirectory, { recursive: true, force: true });
  });

  it('parses configuration and applies operational limits', () => {
    const config = parseBulkEnvironment(valid);
    expect(config).toMatchObject({
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 3008,
      httpRequestTimeoutMs: 15000,
      httpHeadersTimeoutMs: 10000,
      httpKeepAliveTimeoutMs: 5000,
      httpMaxRequestsPerSocket: 100,
      httpMaxHeadersCount: 100,
      databasePoolMax: 2,
      databaseConnectionTimeoutMs: 1500,
      databaseQueryTimeoutMs: 2000,
      databaseIdleTimeoutMs: 30000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('prefers BULK_SVC_PORT and accepts the deployment PORT pair', () => {
    expect(
      parseBulkEnvironment({ ...valid, PORT: '3008', BULK_SVC_PORT: '3009' })
        .port,
    ).toBe(3009);
    expect(
      parseBulkEnvironment({
        NODE_ENV: 'production',
        PORT: '3008',
        BULK_SVC_PORT: '3008',
        DATABASE_URL:
          remoteUrl +
          '?sslmode=verify-full&sslrootcert=' +
          encodeURIComponent(caPath),
      }).port,
    ).toBe(3008);
  });

  it.each([undefined, '', 'staging', 'Production'])(
    'rejects NODE_ENV %j without echoing it',
    (nodeEnv) => {
      expect(() =>
        parseBulkEnvironment({ ...valid, NODE_ENV: nodeEnv }),
      ).toThrow(InvalidBulkEnvironment);
    },
  );

  it.each([
    '',
    ' 3008',
    '3008 ',
    '3.5',
    '3e3',
    '0xbbb',
    '0',
    '65536',
    '3008.0',
  ])('rejects port %j without echoing it', (port) => {
    try {
      parseBulkEnvironment({ ...valid, BULK_SVC_PORT: port });
      throw new Error('Expected invalid port to fail.');
    } catch (error) {
      expect((error as Error).message).toBe('Puerto de bulk-svc inválido.');
      if (port) expect((error as Error).message).not.toContain(port);
    }
  });

  it('uses liveness-only configuration when DATABASE_URL is absent, even when PG variables exist', () => {
    const config = parseBulkEnvironment({
      ...valid,
      PGHOST: 'db.internal',
      PGSSLMODE: 'verify-full',
    });
    expect(config.databaseUrl).toBeUndefined();
  });

  it.each([
    '',
    'not-a-url',
    'mysql://user:secret-value@db.example.test/database',
    'postgresql://user:secret-value@db.example.test/',
    'postgresql://user:secret-value@db.example.test/database#',
  ])(
    'rejects malformed DATABASE_URL without exposing credentials',
    (databaseUrl) => {
      expect(() =>
        parseBulkEnvironment({ ...valid, DATABASE_URL: databaseUrl }),
      ).toThrow(InvalidBulkEnvironment);
      try {
        parseBulkEnvironment({ ...valid, DATABASE_URL: databaseUrl });
      } catch (error) {
        expect((error as Error).message).not.toContain('secret-value');
      }
    },
  );

  it('rejects TLS bypasses and requires explicit local plaintext mode', () => {
    expect(() =>
      parseBulkEnvironment({
        ...valid,
        DATABASE_URL: remoteUrl + '?sslmode=disable',
      }),
    ).toThrow('verify-full');
    expect(() =>
      parseBulkEnvironment({ ...valid, NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    ).toThrow('TLS global');
    expect(() =>
      parseBulkEnvironment({
        ...valid,
        DATABASE_URL: 'postgres://u:p@127.0.0.1/db',
      }),
    ).toThrow('verify-full');
    expect(
      parseBulkEnvironment({
        ...valid,
        DATABASE_URL: 'postgres://u:p@127.0.0.1/db?sslmode=disable',
      }).databaseSsl,
    ).toBe(false);
    expect(() =>
      parseBulkEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@127.0.0.1/db?sslmode=disable',
      }),
    ).toThrow('verify-full');
    expect(() =>
      parseBulkEnvironment({
        ...valid,
        DATABASE_URL: 'postgres://u:p@127.0.0.1/db?sslmode=disable',
        PGSSLROOTCERT: caPath,
      }),
    ).toThrow('No se permite configurar una CA');
  });

  it('requires verify-full and validates CA for remote PostgreSQL', () => {
    const config = parseBulkEnvironment({
      NODE_ENV: 'production',
      BULK_SVC_PORT: '3008',
      DATABASE_URL:
        remoteUrl +
        '?sslmode=verify-full&sslrootcert=' +
        encodeURIComponent(caPath),
    });
    expect(config.databaseSsl).toMatchObject({
      rejectUnauthorized: true,
      checkServerIdentity,
      ca: rootCertificates[0],
    });
    expect(config.databaseUrl).not.toContain('sslmode');
    expect(config.databaseUrl).not.toContain('sslrootcert');
    expect(() =>
      parseBulkEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: remoteUrl + '?sslmode=verify-full',
      }),
    ).toThrow('CA explícita');
    expect(() =>
      parseBulkEnvironment({
        NODE_ENV: 'development',
        DATABASE_URL: remoteUrl,
      }),
    ).toThrow('verify-full');
  });

  it.each(invalidCaCases)(
    'rejects a real $nombre CA file without exposing its contents or path',
    ({ path, contents }) => {
      if (contents) writeFileSync(path, contents);
      try {
        expect(() =>
          parseBulkEnvironment({
            NODE_ENV: 'production',
            DATABASE_URL:
              remoteUrl +
              '?sslmode=verify-full&sslrootcert=' +
              encodeURIComponent(path),
          }),
        ).toThrow('CA legible y válida');
        try {
          parseBulkEnvironment({
            NODE_ENV: 'production',
            DATABASE_URL:
              remoteUrl +
              '?sslmode=verify-full&sslrootcert=' +
              encodeURIComponent(path),
          });
        } catch (error) {
          expect((error as Error).message).not.toContain(path);
          if (contents)
            expect((error as Error).message).not.toContain(contents);
        }
      } finally {
        if (contents) rmSync(path, { force: true });
      }
    },
  );

  it.each([
    () => {
      throw new Error();
    },
    () => 'not a certificate',
  ])('rejects missing or invalid CA data', (reader) => {
    expect(() =>
      parseBulkEnvironment(
        {
          NODE_ENV: 'production',
          DATABASE_URL:
            remoteUrl +
            '?sslmode=verify-full&sslrootcert=' +
            encodeURIComponent(caPath),
        },
        reader,
      ),
    ).toThrow('CA legible y válida');
  });

  it.each([
    'sslmode=verify-full&unknown=x',
    'sslmode=verify-full&sslmode=disable',
    'sslmode=verify-full&sslrootcert=a&sslrootcert=b',
  ])('rejects unknown or repeated URL parameters: %s', (query) => {
    expect(() =>
      parseBulkEnvironment(
        { ...valid, DATABASE_URL: `${remoteUrl}?${query}` },
        certificateReader,
      ),
    ).toThrow('parámetros TLS únicos');
  });

  it('rejects conflicting TLS sources and validates runtime host binding', () => {
    expect(() =>
      parseBulkEnvironment({
        ...valid,
        DATABASE_URL: remoteUrl + '?sslmode=verify-full',
        PGSSLMODE: 'disable',
      }),
    ).toThrow('conflictiva');
    expect(() =>
      parseBulkEnvironment({ ...valid, BULK_SVC_HOST: 'localhost' }),
    ).toThrow('BULK_SVC_HOST');
    expect(
      parseBulkEnvironment({ NODE_ENV: 'production', PORT: '3008' }).host,
    ).toBe('0.0.0.0');
  });
});
