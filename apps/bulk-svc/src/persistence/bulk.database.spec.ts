import { Pool } from 'pg';
import { createBulkDatabase } from './bulk.database.js';
import { BulkPersistenceRepository } from './bulk.repository.js';

describe('bulk Drizzle provider', () => {
  it('does not wrap readiness doubles as database pools', () => {
    expect(
      createBulkDatabase({
        query: async () => undefined,
        end: async () => undefined,
      }),
    ).toBeNull();
    expect(createBulkDatabase(null)).toBeNull();
  });

  it('classifies operations without a configured adapter', async () => {
    const repository = new BulkPersistenceRepository(null);
    await expect(
      repository.findBatchByBatchId('not-used'),
    ).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('creates Drizzle only from a real pg Pool', async () => {
    const pool = new Pool({
      connectionString:
        'postgresql://unused:unused@127.0.0.1:1/unused?sslmode=disable',
    });
    try {
      expect(createBulkDatabase(pool)).toBeDefined();
    } finally {
      await pool.end();
    }
  });
});
