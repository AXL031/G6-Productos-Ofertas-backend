import { inPromotionsTransaction, type SqlClient } from './sql-transaction.js';

describe('Promotions transaction failure handling', () => {
  function fixture(fail: (statement: string) => boolean) {
    const queries: string[] = [];
    const release = vi.fn();
    const client: SqlClient = {
      query: async (statement) => {
        queries.push(statement);
        if (fail(statement)) throw new Error('synthetic-driver-failure');
        return { rows: [] };
      },
      release,
    };
    return { pool: { connect: async () => client }, queries, release };
  }

  it('rolls back a deferred constraint failure at commit and releases the connection', async () => {
    const f = fixture((statement) => statement === 'COMMIT');
    await expect(
      inPromotionsTransaction(f.pool, async (client) => {
        await client.query('business-write');
      }),
    ).rejects.toThrow('synthetic-driver-failure');
    expect(f.queries.slice(-3)).toEqual([
      'business-write',
      'COMMIT',
      'ROLLBACK',
    ]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('destroys a connection if rollback fails, while preserving the original failure', async () => {
    const f = fixture((statement) => statement === 'ROLLBACK');
    const original = new Error('original');
    await expect(
      inPromotionsTransaction(f.pool, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('releases the client when BEGIN fails and never invokes business work', async () => {
    const f = fixture((statement) => statement === 'BEGIN');
    const work = vi.fn();
    await expect(inPromotionsTransaction(f.pool, work)).rejects.toThrow(
      'synthetic-driver-failure',
    );
    expect(work).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('does not reuse or release a connection it failed to acquire', async () => {
    const f = fixture(() => false);
    const pool = {
      connect: async (): Promise<SqlClient> => {
        throw new Error('acquire-failed');
      },
    };
    await expect(
      inPromotionsTransaction(pool, async () => undefined),
    ).rejects.toThrow('acquire-failed');
    expect(f.release).not.toHaveBeenCalled();
  });
});
