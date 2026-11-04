import {
  BulkPersistenceError,
  persistenceError,
} from './bulk.persistence.errors.js';

describe('bulk persistence error mapping', () => {
  it.each([
    ['23505', 'UNIQUE_CONFLICT'],
    ['23503', 'FOREIGN_KEY_VIOLATION'],
    ['23514', 'CHECK_VIOLATION'],
    ['23502', 'NOT_NULL_VIOLATION'],
    ['57014', 'TIMEOUT'],
    ['ECONNREFUSED', 'CONNECTION_FAILURE'],
  ] as const)(
    'maps SQLSTATE %s to a safe public category',
    (sqlState, category) => {
      const result = persistenceError(
        new Error('driver details', { cause: { code: sqlState } }),
      );
      expect(result.code).toBe(category);
      expect(result.message).not.toContain(sqlState);
      expect(result.message).not.toContain('driver details');
      expect(result.cause).toBeInstanceOf(Error);
    },
  );

  it('preserves an already classified error and its cause', () => {
    const cause = new Error('private diagnostic');
    const result = new BulkPersistenceError('NOT_CONFIGURED', cause);
    expect(persistenceError(result)).toBe(result);
    expect(result.cause).toBe(cause);
    expect(result.message).not.toContain(cause.message);
  });
});
