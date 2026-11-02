import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvironmentFixture } from '../../../test/support/environment.js';
import {
  PromotionsConfigService,
  PromotionsConfigurationError,
  readPromotionsEnvironment,
  validatePromotionsConfiguration,
} from './promotions-config.js';

describe('Promotions configuration', () => {
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());
  it('validates paired service credentials against the HTTPS G7 issuer without exposing the secret', () => {
    const credentials = {
      AUTH_ISSUER: 'https://g7.test/api/v1/auth',
      AUTH_JWKS_URL: 'https://g7.test/api/v1/auth/.well-known/jwks.json',
      PROMOTIONS_SERVICE_TOKEN_URL: 'https://g7.test/api/v1/auth/token',
      PROMOTIONS_SERVICE_CLIENT_SECRET: 'synthetic-secret',
    };
    const settings = validatePromotionsConfiguration({
      ...fixture.environment,
      ...credentials,
    });
    expect(settings.serviceCredentials?.tokenUrl).toBe(
      credentials.PROMOTIONS_SERVICE_TOKEN_URL,
    );
    expect(JSON.stringify(new PromotionsConfigService(settings))).not.toContain(
      'synthetic-secret',
    );
    for (const overrides of [
      { PROMOTIONS_SERVICE_TOKEN_URL: undefined },
      { PROMOTIONS_SERVICE_CLIENT_SECRET: undefined },
      { PROMOTIONS_SERVICE_CLIENT_SECRET: '' },
      { AUTH_ISSUER: undefined, AUTH_JWKS_URL: undefined },
      ...[
        'http://g7.test/api/v1/auth/token',
        'https://wrong.test/api/v1/auth/token',
        'https://g7.test/wrong',
        'https://g7.test/api/v1/auth/token?secret=x',
        'https://user:secret@g7.test/api/v1/auth/token',
      ].map((PROMOTIONS_SERVICE_TOKEN_URL) => ({
        PROMOTIONS_SERVICE_TOKEN_URL,
      })),
    ]) {
      expect(() =>
        validatePromotionsConfiguration({
          ...fixture.environment,
          ...credentials,
          ...overrides,
        }),
      ).toThrow(PromotionsConfigurationError);
    }
  });
  it('requires a paired HTTPS issuer/JWKS configuration and does not serialize it', () => {
    for (const auth of [
      { AUTH_ISSUER: 'https://issuer.test' },
      { AUTH_JWKS_URL: 'https://issuer.test/jwks' },
      { AUTH_ISSUER: '', AUTH_JWKS_URL: '' },
      {
        AUTH_ISSUER: 'http://issuer.test',
        AUTH_JWKS_URL: 'https://issuer.test/jwks',
      },
      {
        AUTH_ISSUER: 'https://issuer.test',
        AUTH_JWKS_URL: 'https://user:secret@issuer.test/jwks',
      },
      {
        AUTH_ISSUER: 'https://issuer.test',
        AUTH_JWKS_URL: 'https://issuer.test/jwks?token=secret',
      },
    ])
      expect(() =>
        validatePromotionsConfiguration({ ...fixture.environment, ...auth }),
      ).toThrow(PromotionsConfigurationError);
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        AUTH_ISSUER: 'https://issuer.test',
        AUTH_JWKS_URL: 'https://issuer.test/jwks',
      }),
    );
    expect(config.settings.auth?.issuer).toBe('https://issuer.test');
    expect(JSON.stringify(config)).not.toContain('issuer');
  });

  it('maps the official PostgreSQL variables to immutable typed settings', () => {
    const settings = validatePromotionsConfiguration(fixture.environment);
    expect(settings).toMatchObject({
      environment: 'test',
      port: 3004,
      database: { schema: 'promotions', connectionMode: 'session', port: 5432 },
    });
    expect(Object.isFrozen(settings.database)).toBe(true);
    expect(JSON.stringify(new PromotionsConfigService(settings))).not.toContain(
      'password',
    );
  });
  it('validates optional existing Gateway upstream variables without enabling public token-free traffic', () => {
    expect(
      validatePromotionsConfiguration(fixture.environment).upstreams,
    ).toEqual({});
    expect(
      validatePromotionsConfiguration({
        ...fixture.environment,
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        GATEWAY_CATALOG_SVC_URL: 'http://catalog-svc:3001',
        GATEWAY_TAXONOMY_SVC_URL: 'http://127.0.0.1:3006',
      }).upstreams,
    ).toMatchObject({
      catalog: 'http://catalog-svc:3001',
      taxonomy: 'http://127.0.0.1:3006',
    });
    for (const url of [
      'https://public.example',
      'http://pricing-svc:3002',
      'http://user:secret@catalog-svc:3001',
      'http://catalog-svc:3001/path',
    ])
      expect(() =>
        validatePromotionsConfiguration({
          ...fixture.environment,
          GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
          GATEWAY_CATALOG_SVC_URL: url,
        }),
      ).toThrow('GATEWAY_CATALOG_SVC_URL');
  });

  it('enables token-free local development explicitly and binds only loopback', () => {
    expect(validatePromotionsConfiguration(fixture.environment)).toMatchObject({
      localDemoEnabled: false,
      listenHost: '::',
    });
    for (const NODE_ENV of ['development', 'test'])
      expect(
        validatePromotionsConfiguration({
          ...fixture.environment,
          NODE_ENV,
          GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        }),
      ).toMatchObject({ localDemoEnabled: true, listenHost: '127.0.0.1' });
    expect(
      validatePromotionsConfiguration({
        ...fixture.environment,
        NODE_ENV: 'production',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      }),
    ).toMatchObject({
      localDemoEnabled: true,
      listenHost: '0.0.0.0',
      couponRuntimeEnabled: false,
    });
    for (const NODE_ENV of [undefined])
      expect(() =>
        validatePromotionsConfiguration({
          ...fixture.environment,
          NODE_ENV,
          GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        }),
      ).toThrow('GATEWAY_DEMO_NO_AUTH_ENABLED');
  });

  it('disables probes and coupon runtime unless explicitly enabled', () => {
    const environment = { ...fixture.environment };
    delete environment.PROMOTIONS_DEPENDENCY_PROBES_ENABLED;
    delete environment.PROMOTIONS_COUPON_RUNTIME_ENABLED;
    expect(validatePromotionsConfiguration(environment)).toMatchObject({
      dependencyProbesEnabled: false,
      couponRuntimeEnabled: false,
    });
    expect(
      validatePromotionsConfiguration({
        ...environment,
        PROMOTIONS_DEPENDENCY_PROBES_ENABLED: 'true',
        PROMOTIONS_COUPON_RUNTIME_ENABLED: 'true',
      }),
    ).toMatchObject({
      dependencyProbesEnabled: true,
      couponRuntimeEnabled: true,
    });
  });

  it.each([
    'PROMOTIONS_DEPENDENCY_PROBES_ENABLED',
    'PROMOTIONS_COUPON_RUNTIME_ENABLED',
    'GATEWAY_DEMO_NO_AUTH_ENABLED',
  ])('rejects ambiguous activation in %s', (name) => {
    for (const value of ['', '1', 'TRUE', ' false '])
      expect(() =>
        validatePromotionsConfiguration({
          ...fixture.environment,
          [name]: value,
        }),
      ).toThrow(name);
  });

  it.each([
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'G6_DATABASE_SCHEMA',
    'G6_CONNECTION_MODE',
    'RABBITMQ_URL',
  ])('rejects missing required variable %s', (name) => {
    const environment: NodeJS.ProcessEnv = { ...fixture.environment };
    delete environment[name];
    expect(() => validatePromotionsConfiguration(environment)).toThrow(
      PromotionsConfigurationError,
    );
    try {
      validatePromotionsConfiguration(environment);
    } catch (error) {
      expect(error).toBeInstanceOf(PromotionsConfigurationError);
      expect((error as PromotionsConfigurationError).variables).toContain(name);
    }
  });

  it.each(['', '0', '65536', '3e3', '0xbbc', ' 3004 ', '3004\n', '3004.5'])(
    'rejects malformed HTTP port %j',
    (port) => {
      expect(() =>
        validatePromotionsConfiguration({
          ...fixture.environment,
          PROMOTIONS_SVC_PORT: port,
        }),
      ).toThrow('PROMOTIONS_SVC_PORT');
    },
  );

  it('preserves port precedence and the existing fallback', () => {
    const environment: NodeJS.ProcessEnv = {
      ...fixture.environment,
      PORT: '3200',
    };
    expect(validatePromotionsConfiguration(environment).port).toBe(3004);
    delete environment.PROMOTIONS_SVC_PORT;
    expect(validatePromotionsConfiguration(environment).port).toBe(3200);
    delete environment.PORT;
    expect(validatePromotionsConfiguration(environment).port).toBe(3004);
  });

  it('rejects an unreadable or malformed CA instead of downgrading TLS', () => {
    const path = join(fixture.directory, 'invalid.crt');
    writeFileSync(path, 'not a certificate');
    expect(() =>
      validatePromotionsConfiguration({
        ...fixture.environment,
        PGSSLROOTCERT: path,
      }),
    ).toThrow('PGSSLROOTCERT');
  });

  it.each([
    ['NODE_ENV', 'unknown'],
    ['PGPORT', '0'],
    ['PGHOST', 'postgresql://user:secret@localhost'],
    ['PGHOST', 'localhost\n'],
    ['PGSSLMODE', 'disable'],
    ['PGSSLROOTCERT', 'relative.crt'],
    ['PGSSLROOTCERT', fixture.directory],
    ['PGSSLROOTCERT', join(fixture.directory, 'missing.crt')],
    ['G6_DATABASE_SCHEMA', 'inventory'],
    ['G6_CONNECTION_MODE', 'transaction'],
    ['RABBITMQ_URL', 'https://user:secret@localhost'],
    ['RABBITMQ_URL', 'amqp://localhost:0'],
    ['RABBITMQ_URL', 'amqp://localhost/test\n'],
    ['RABBITMQ_URL', 'amqp://localhost/test?password=secret'],
  ])('rejects invalid %s without echoing its value', (name, value) => {
    try {
      validatePromotionsConfiguration({
        ...fixture.environment,
        [name]: value,
      });
      expect.fail('Expected invalid configuration');
    } catch (error) {
      expect(error).toBeInstanceOf(PromotionsConfigurationError);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('loads root, service-local and process configuration in that precedence', () => {
    mkdirSync(join(fixture.directory, 'apps/promotions-svc'), {
      recursive: true,
    });
    writeFileSync(join(fixture.directory, '.env'), 'PORT=3100\nPGHOST=root\n');
    writeFileSync(
      join(fixture.directory, 'apps/promotions-svc/.env.local'),
      'PORT=3200\nPGHOST=service\n',
    );
    const processEnvironment = { PGHOST: 'process' };
    expect(
      readPromotionsEnvironment(fixture.directory, processEnvironment),
    ).toEqual({ PORT: '3200', PGHOST: 'process' });
    expect(processEnvironment).toEqual({ PGHOST: 'process' });
  });
});
