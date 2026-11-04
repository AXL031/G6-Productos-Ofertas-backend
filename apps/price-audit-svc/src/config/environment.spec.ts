import { describe, expect, it } from 'vitest';
import { validateEnvironment, validateAmqpUrl } from './environment.js';
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PRICE_AUDIT_SVC_PORT: '3003',
  DATABASE_URL: 'postgresql://audit:secret@127.0.0.1/audit_test',
  AUTH_ISSUER: 'https://identity.invalid',
  AUTH_JWKS_URL: 'https://identity.invalid/jwks',
};
describe('Configuración fail-closed de Price Audit', () => {
  it('fija retención administrativa sin activar un archivador', () => {
    expect(validateEnvironment(env)).toMatchObject({
      port: 3003,
      databaseSsl: false,
      hotRetentionMonths: 24,
      archiveRetentionYears: 5,
    });
  });
  it.each([
    'NODE_ENV',
    'PRICE_AUDIT_SVC_PORT',
    'DATABASE_URL',
    'AUTH_ISSUER',
    'AUTH_JWKS_URL',
  ])('rechaza configuración ausente: %s', (key) => {
    expect(() => validateEnvironment({ ...env, [key]: undefined })).toThrow();
  });
  it.each([
    { PRICE_AUDIT_SVC_PORT: '0' },
    { PRICE_AUDIT_SVC_PORT: '3.5' },
    { DATABASE_URL: 'postgresql://audit:secret@remote.invalid/audit_test' },
    { DATABASE_URL: env.DATABASE_URL + '?options=unsafe' },
    { AUTH_JWKS_URL: 'http://remote.invalid/jwks' },
    { AUTH_JWKS_URL: 'https://user:secret@identity.invalid/jwks' },
    { AUDIT_HOT_RETENTION_MONTHS: '0' },
    { AUDIT_ARCHIVE_RETENTION_YEARS: 'Infinity' },
  ])('rechaza valores inseguros sin revelar secretos: %j', (values) => {
    expect(() => validateEnvironment({ ...env, ...values })).toThrow();
    try {
      validateEnvironment({ ...env, ...values });
    } catch (error) {
      expect(String(error)).not.toMatch(/secret|unsafe|remote.invalid/);
    }
  });
  it('exige TLS incluso para loopback productivo', () => {
    expect(() =>
      validateEnvironment({ ...env, NODE_ENV: 'production' }),
    ).toThrow();
    expect(
      validateEnvironment({
        ...env,
        NODE_ENV: 'production',
        PGSSLMODE: 'verify-full',
      }).databaseSsl,
    ).toMatchObject({ rejectUnauthorized: true });
  });
  it('no acepta el bypass de demo de otro servicio como autorización', () => {
    expect(() =>
      validateEnvironment({
        ...env,
        AUTH_ISSUER: undefined,
        AUTH_JWKS_URL: undefined,
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      }),
    ).toThrow();
  });
  it.each([
    'amqp://user:secret@remote.invalid',
    'amqp://user:secret@localhost?heartbeat=0',
    'amqps://host',
    'https://user:secret@host',
  ])('rechaza AMQP inseguro: %s', (value) => {
    expect(() => validateAmqpUrl(value, 'test')).toThrow();
  });
  it('permite AMQP loopback solo en pruebas y exige AMQPS productivo', () => {
    expect(validateAmqpUrl('amqp://user:secret@127.0.0.1', 'test')).toContain(
      'heartbeat=5',
    );
    expect(() =>
      validateAmqpUrl('amqp://user:secret@localhost', 'production'),
    ).toThrow();
    expect(validateAmqpUrl('amqps://user:secret@host', 'production')).toContain(
      'amqps:',
    );
    expect(() =>
      validateEnvironment({ ...env, AUDIT_EXPORT_DIRECTORY: 'relative' }),
    ).toThrow();
  });
});
