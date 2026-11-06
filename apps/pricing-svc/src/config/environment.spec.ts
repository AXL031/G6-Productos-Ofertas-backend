import { InvalidPricingConfig, validateEnvironment } from './environment.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { Client } from 'pg';

const valid = {
  NODE_ENV: 'test',
  PRICING_SVC_PORT: '3002',
  DATABASE_URL: 'postgresql://pricing:fixture-password@127.0.0.1:5432/fixture',
};

describe('Pricing configuration', () => {
  it('mantiene cerrada por defecto la publicación tipada y exige broker para habilitarla', () => {
    expect(validateEnvironment(valid).priceChangedPublishingEnabled).not.toBe(
      true,
    );
    expect(() =>
      validateEnvironment({
        ...valid,
        PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'true',
      }),
    ).toThrow('requiere PRICING_AMQP_URL');
    expect(() =>
      validateEnvironment({
        ...valid,
        PRICING_PRICE_CHANGED_PUBLISH_ENABLED: 'yes',
      }),
    ).toThrow(InvalidPricingConfig);
  });
  it('rejects legacy anonymous bypass and accepts independent simulated auth', () => {
    expect(() =>
      validateEnvironment({ ...valid, GATEWAY_DEMO_NO_AUTH_ENABLED: 'true' }),
    ).toThrow('bypasses demo heredados están deshabilitados');
    expect(
      validateEnvironment({
        ...valid,
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        AUTH_ISSUER: 'https://g7.example',
        AUTH_JWKS_URL: 'https://g7.example/jwks',
        SIMULATED_AUTH_ISSUER: 'http://127.0.0.1:8080/sim',
        SIMULATED_AUTH_JWKS_URL: 'http://127.0.0.1:8080/jwks',
      }),
    ).toMatchObject({
      securityMode: 'SIMULATED_AUTH',
      auth: {
        issuer: 'http://127.0.0.1:8080/sim',
        jwksUrl: 'http://127.0.0.1:8080/jwks',
      },
    });
  });
  it('production rechaza el bypass legado y mantiene TLS obligatorio', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      DATABASE_URL: valid.DATABASE_URL + '?sslmode=verify-full',
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      PRICING_DEMO_PRODUCTION_CONFIRMED: 'true',
      AUTH_ISSUER: 'ignored-invalid',
    };
    expect(() =>
      validateEnvironment({ ...production, DATABASE_URL: valid.DATABASE_URL }),
    ).toThrow('bypasses demo heredados están deshabilitados');
  });
  it.each([undefined, 'false'])(
    'production conserva autenticación cuando el flag heredado es %j',
    (demo) => {
      const config = validateEnvironment({
        ...valid,
        NODE_ENV: 'production',
        DATABASE_URL: valid.DATABASE_URL + '?sslmode=verify-full',
        GATEWAY_DEMO_NO_AUTH_ENABLED: demo,
        AUTH_ISSUER: 'https://identity.test',
        AUTH_JWKS_URL: 'https://identity.test/jwks',
      });
      expect(config.auth).toEqual({
        issuer: 'https://identity.test',
        jwksUrl: 'https://identity.test/jwks',
      });
    },
  );
  it('valida ambas URLs de identidad sin permitir secretos, fragmentos ni HTTP remoto', () => {
    expect(
      validateEnvironment({
        ...valid,
        AUTH_ISSUER: 'https://identity.test',
        AUTH_JWKS_URL: 'https://identity.test/jwks',
      }).auth,
    ).toEqual({
      issuer: 'https://identity.test',
      jwksUrl: 'https://identity.test/jwks',
    });
    for (const pair of [
      { AUTH_ISSUER: 'https://identity.test' },
      {
        AUTH_ISSUER: 'https://identity.test',
        AUTH_JWKS_URL: 'http://identity.test/jwks',
      },
      {
        AUTH_ISSUER: 'https://user:secret@identity.test',
        AUTH_JWKS_URL: 'https://identity.test/jwks',
      },
      {
        AUTH_ISSUER: 'https://identity.test#fragment',
        AUTH_JWKS_URL: 'https://identity.test/jwks',
      },
    ])
      expect(() => validateEnvironment({ ...valid, ...pair })).toThrow(
        InvalidPricingConfig,
      );
  });
  it('acepta configuración válida y prioriza el puerto propio', () => {
    expect(validateEnvironment({ ...valid, PORT: '3000' })).toEqual({
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: valid.DATABASE_URL,
      databaseSsl: false,
      securityMode: 'G7_AUTHENTICATED',
      publicOperations: [],
    });
    expect(
      validateEnvironment({
        ...valid,
        PRICING_SVC_PORT: undefined,
        PORT: '4002',
      }).port,
    ).toBe(4002);
  });

  it('selects an independent simulated issuer/JWKS and keeps the selector reversible', () => {
    const simulated = validateEnvironment({
      ...valid,
      G6_SECURITY_MODE: 'SIMULATED_AUTH',
      SIMULATED_AUTH_ISSUER: 'http://127.0.0.1:8080/sim',
      SIMULATED_AUTH_JWKS_URL: 'http://127.0.0.1:8080/jwks',
    });
    expect(simulated).toMatchObject({
      securityMode: 'SIMULATED_AUTH',
      auth: {
        issuer: 'http://127.0.0.1:8080/sim',
        jwksUrl: 'http://127.0.0.1:8080/jwks',
      },
    });
    expect(() =>
      validateEnvironment({
        ...valid,
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: valid.AUTH_ISSUER,
        SIMULATED_AUTH_JWKS_URL: valid.AUTH_JWKS_URL,
      }),
    ).toThrow(InvalidPricingConfig);
  });

  it.each(['NODE_ENV', 'PRICING_SVC_PORT', 'DATABASE_URL'])(
    'rechaza %s ausente o vacía',
    (name) => {
      for (const value of [undefined, '', ' ']) {
        expect(() => validateEnvironment({ ...valid, [name]: value })).toThrow(
          InvalidPricingConfig,
        );
      }
    },
  );

  it.each([
    '0',
    '65536',
    '-1',
    '1.2',
    'NaN',
    '3e3',
    '0xbb8',
    ' 3002',
    'fixture-secret',
  ])('rechaza puerto %s sin exponer su valor', (port) => {
    expect(() =>
      validateEnvironment({ ...valid, PRICING_SVC_PORT: port, PORT: '3000' }),
    ).toThrow('PRICING_SVC_PORT (o PORT) debe ser un entero entre 1 y 65535.');
  });

  it.each([
    'fixture-secret',
    'https://user:fixture-secret@host/db',
    'postgresql:///db',
    'postgresql://user:fixture-secret@host',
    'postgresql://host/db',
    'postgresql://user@host:0/db',
    'postgresql://user@host:65536/db',
    'postgresql://user@host:abc/db',
    'postgresql://user@host/db#fixture-secret',
    'postgresql://user@host/ ',
  ])('rechaza una URL malformada sin reflejar credenciales (%#)', (url) => {
    expect(() => validateEnvironment({ ...valid, DATABASE_URL: url })).toThrow(
      'DATABASE_URL debe incluir host, usuario y base PostgreSQL válidos.',
    );
  });

  it('rechaza un entorno desconocido sin reflejarlo', () => {
    expect(() =>
      validateEnvironment({ ...valid, NODE_ENV: 'fixture-secret' }),
    ).toThrow('NODE_ENV debe ser development, test o production.');
  });

  describe('TLS fail-closed', () => {
    const remoteUrl = 'postgresql://pricing:fixture@db.example.invalid/fixture';
    const caPath = join(tmpdir(), `pricing-ca-${randomUUID()}.crt`);
    beforeAll(() => writeFileSync(caPath, rootCertificates[0]));
    afterAll(() => unlinkSync(caPath));

    it.each([
      undefined,
      'disable',
      'allow',
      'prefer',
      'require',
      'verify-ca',
      'no-verify',
      '',
    ])('rechaza producción sin verify-full (%s)', (mode) => {
      const url =
        mode === undefined ? remoteUrl : `${remoteUrl}?sslmode=${mode}`;
      expect(() =>
        validateEnvironment({
          ...valid,
          NODE_ENV: 'production',
          DATABASE_URL: url,
        }),
      ).toThrow('sslmode=verify-full');
    });

    it('solo permite texto plano en localhost fuera de producción', () => {
      expect(
        validateEnvironment({
          ...valid,
          DATABASE_URL: `${valid.DATABASE_URL}?sslmode=disable`,
        }).databaseSsl,
      ).toBe(false);
      expect(() =>
        validateEnvironment({ ...valid, NODE_ENV: 'production' }),
      ).toThrow('sslmode=verify-full');
      expect(() =>
        validateEnvironment({ ...valid, DATABASE_URL: remoteUrl }),
      ).toThrow('sslmode=verify-full');
    });

    it('conserva CA, certificado y hostname verificados después del parser de pg', () => {
      const config = validateEnvironment({
        ...valid,
        NODE_ENV: 'production',
        DATABASE_URL: `${remoteUrl}?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`,
      });
      expect(config.databaseUrl).toBe(remoteUrl);
      expect(config.databaseSsl).toEqual({
        rejectUnauthorized: true,
        checkServerIdentity,
        ca: rootCertificates[0],
      });
      const client = new Client({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl,
      });
      expect(client.ssl).toEqual(config.databaseSsl);
    });

    it('admite verify-full con las CA de confianza de Node o PGSSLROOTCERT', () => {
      expect(
        validateEnvironment({
          ...valid,
          NODE_ENV: 'production',
          DATABASE_URL: remoteUrl,
          PGSSLMODE: 'verify-full',
        }).databaseSsl,
      ).toEqual({ rejectUnauthorized: true, checkServerIdentity });
      expect(
        validateEnvironment({
          ...valid,
          NODE_ENV: 'production',
          DATABASE_URL: `${remoteUrl}?sslmode=verify-full`,
          PGSSLROOTCERT: caPath,
        }).databaseSsl,
      ).toHaveProperty('ca', rootCertificates[0]);
    });

    it.each([
      'ssl=0',
      'ssl=no-verify',
      'sslmode=verify-full&sslmode=disable',
      'host=localhost',
      'uselibpqcompat=true',
      'sslcert=fixture',
    ])('impide sobrescribir la configuración validada (%s)', (query) => {
      expect(() =>
        validateEnvironment({
          ...valid,
          NODE_ENV: 'production',
          DATABASE_URL: `${remoteUrl}?${query}`,
        }),
      ).toThrow(InvalidPricingConfig);
    });

    it('rechaza CA ilegible/malformada y TLS global desactivado sin reflejar valores', () => {
      const secure = {
        ...valid,
        NODE_ENV: 'production',
        DATABASE_URL: `${remoteUrl}?sslmode=verify-full`,
      };
      expect(() =>
        validateEnvironment({
          ...secure,
          PGSSLROOTCERT: 'arbitrary-unknown-value',
        }),
      ).toThrow('CA legible');
      writeFileSync(caPath, 'arbitrary-unknown-value');
      try {
        expect(() =>
          validateEnvironment({ ...secure, PGSSLROOTCERT: caPath }),
        ).toThrow('CA legible');
      } finally {
        writeFileSync(caPath, rootCertificates[0]);
      }
      expect(() =>
        validateEnvironment({ ...secure, NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
      ).toThrow('TLS global');
    });
  });
});
