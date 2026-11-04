import { ServiceUnavailableException } from '@nestjs/common';
import {
  CatalogPersistenceError,
  translatePostgresFailure,
} from './database-errors.js';

describe('safe PostgreSQL failure translation', () => {
  it.each([
    ['23505', false, 'unique'],
    ['23503', false, 'foreign_key'],
    ['23502', false, 'not_null'],
    ['23514', false, 'check'],
    ['40001', false, 'serialization'],
    ['40P01', false, 'deadlock'],
    ['08006', false, 'connection'],
    ['ECONNRESET', false, 'connection'],
    ['53300', false, 'connection'],
    ['57P01', false, 'connection'],
    ['57014', false, 'connection'],
    ['55P03', false, 'connection'],
    ['42501', false, 'other'],
    ['23514', true, 'deferred_constraint'],
  ] as const)(
    'classifies SQLSTATE %s at commit=%s',
    (code, commit, expected) => {
      const error = Object.assign(new Error('private SQL and password'), {
        code,
        constraint: 'catalog_internal_guard',
      });
      const translated = translatePostgresFailure(error, commit);
      expect(translated).toBeDefined();
      if (!translated) throw new Error('Expected a PostgreSQL failure');
      expect(translated).toBeInstanceOf(CatalogPersistenceError);
      expect(translated.failure).toBe(expected);
      expect(translated.sqlState).toBe(
        /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
      );
      expect(translated.constraintName).toBe('catalog_internal_guard');
      expect(translated.message).not.toContain('private SQL');
      expect(translated.message).not.toContain('password');
      expect(translated).not.toBeInstanceOf(ServiceUnavailableException);
    },
  );

  it('does not retain arbitrary driver text or SQL parameters', () => {
    const translated = translatePostgresFailure(
      Object.assign(
        new Error('SELECT secret FROM catalog WHERE token=password'),
        {
          code: '22P02',
          detail: 'sensitive parameter value',
        },
      ),
    );
    expect(translated).toBeDefined();
    if (!translated) throw new Error('Expected a PostgreSQL failure');
    expect(translated.failure).toBe('other');
    expect(JSON.stringify(translated)).not.toContain('secret');
    expect(translated.message).toBe(
      'Falló una operación de persistencia de Catálogo',
    );
  });

  it.each([
    ['23505', false, 'unique'],
    ['23503', false, 'foreign_key'],
    ['23514', false, 'check'],
    ['23514', true, 'deferred_constraint'],
  ] as const)(
    'extracts SQLSTATE %s from DrizzleQueryError.cause at commit=%s',
    (code, commit, expected) => {
      const postgresError = Object.assign(
        new Error('private SQL and parameter'),
        { code, constraint: 'catalog_internal_guard' },
      );
      const drizzleError = Object.assign(new Error('Drizzle query failed'), {
        cause: postgresError,
        query: 'SELECT private_data',
      });
      const translated = translatePostgresFailure(drizzleError, commit);
      expect(translated).toBeDefined();
      if (!translated) throw new Error('Expected a PostgreSQL failure');
      expect(translated.failure).toBe(expected);
      expect(translated.sqlState).toBe(code);
      expect(translated.message).not.toContain('private');
      expect(JSON.stringify(translated)).not.toContain('SELECT');
    },
  );

  it('does not translate business or validation exceptions without a database cause', () => {
    const domainFailure = new Error('catalog validation failed');
    expect(translatePostgresFailure(domainFailure)).toBeUndefined();
  });
  it.each([
    'Query read timeout',
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
    'Connection terminated unexpectedly',
    'Connection terminated',
  ])(
    'classifies pg code-less failure %s through Drizzle without retaining text',
    (message) => {
      const translated = translatePostgresFailure(
        new Error('private SQL', { cause: new Error(message) }),
      );
      expect(translated).toMatchObject({ failure: 'connection' });
      expect(JSON.stringify(translated)).not.toContain('private SQL');
    },
  );
});
