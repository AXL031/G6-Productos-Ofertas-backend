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
  it('demo es explícita, desactivada por defecto y sin dependencia de G7', () => {
    expect(validateEnvironment(valid).demoNoAuthEnabled).not.toBe(true);
    expect(
      validateEnvironment({ ...valid, GATEWAY_DEMO_NO_AUTH_ENABLED: 'false' })
        .demoNoAuthEnabled,
    ).not.toBe(true);
    const demo = validateEnvironment({
      ...valid,
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      AUTH_ISSUER: 'invalid-unused',
    });
    expect(demo.demoNoAuthEnabled).toBe(true);
    expect(demo.auth).toBeUndefined();
    expect(
      validateEnvironment({
        ...valid,
        NODE_ENV: 'development',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      }).demoNoAuthEnabled,
    ).toBe(true);
  });
  it.each(['1', 'TRUE', '', ' true', 'yes'])(
    'rechaza flag demo inválido %j',
    (flag) => {
      expect(() =>
        validateEnvironment({ ...valid, GATEWAY_DEMO_NO_AUTH_ENABLED: flag }),
      ).toThrow(InvalidPricingConfig);
    },
  );
  it.each([undefined, 'false'])(
    'rechaza demo production sin confirmación true (%j)',
    (confirmation) => {
      expect(() =>
        validateEnvironment({
          ...valid,
          NODE_ENV: 'production',
          GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
          PRICING_DEMO_PRODUCTION_CONFIRMED: confirmation,
        }),
      ).toThrow('requiere PRICING_DEMO_PRODUCTION_CONFIRMED=true');
    },
  );
  it.each(['1', 'TRUE', '', ' true', 'yes'])(
    'rechaza confirmación production inválida %j',
    (confirmation) => {
      expect(() =>
        validateEnvironment({
          ...valid,
          PRICING_DEMO_PRODUCTION_CONFIRMED: confirmation,
        }),
      ).toThrow(InvalidPricingConfig);
    },
  );
  it('production admite demo sin G7 solo con ambos flags y mantiene TLS obligatorio', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      DATABASE_URL: valid.DATABASE_URL + '?sslmode=verify-full',
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      PRICING_DEMO_PRODUCTION_CONFIRMED: 'true',
      AUTH_ISSUER: 'ignored-invalid',
    };
    const config = validateEnvironment(production);
    expect(config.demoNoAuthEnabled).toBe(true);
    expect(config.auth).toBeUndefined();
    expect(config.databaseSsl).toMatchObject({
      rejectUnauthorized: true,
      checkServerIdentity,
    });
    expect(() =>
      validateEnvironment({ ...production, DATABASE_URL: valid.DATABASE_URL }),
    ).toThrow('sslmode=verify-full');
  });
  it.each([undefined, 'false'])(
    'production conserva autenticación con demo %j aunque exista confirmación',
    (demo) => {
      const config = validateEnvironment({
        ...valid,
        NODE_ENV: 'production',
        DATABASE_URL: valid.DATABASE_URL + '?sslmode=verify-full',
        GATEWAY_DEMO_NO_AUTH_ENABLED: demo,
        PRICING_DEMO_PRODUCTION_CONFIRMED: 'true',
        AUTH_ISSUER: 'https://identity.test',
        AUTH_JWKS_URL: 'https://identity.test/jwks',
      });
      expect(config.demoNoAuthEnabled).not.toBe(true);
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
    });
    expect(
      validateEnvironment({
        ...valid,
        PRICING_SVC_PORT: undefined,
        PORT: '4002',
      }).port,
    ).toBe(4002);
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
