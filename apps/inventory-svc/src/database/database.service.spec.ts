import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { DatabaseService } from './database.service.js';

vi.mock('pg', () => ({ default: { Pool: vi.fn() } }));

describe('DatabaseService — configuración y atomicidad (#97/#98)', () => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(),
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn(),
  };
  let database: DatabaseService;

  beforeEach(() => {
    vi.resetAllMocks();
    for (const key of [
      'DATABASE_URL',
      'PGHOST',
      'PGPORT',
      'PGDATABASE',
      'PGUSER',
      'PGPASSWORD',
      'PGSSLMODE',
      'PGSSLROOTCERT',
      'INVENTORY_SVC_PORT',
      'PORT',
      'RESERVATION_TTL_SECONDS',
      'DEFAULT_LOW_STOCK_THRESHOLD',
      'INVENTORY_WORKER_INTERVAL_MS',
      'INVENTORY_WORKER_BATCH_SIZE',
    ])
      vi.stubEnv(key, undefined);
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    pool.connect.mockResolvedValue(client);
    pool.end.mockResolvedValue(undefined);
    vi.mocked(pg.Pool).mockImplementation(function () {
      return pool as unknown as pg.Pool;
    });
    database = new DatabaseService();
  });

  afterEach(async () => {
    await database.onModuleDestroy();
    vi.unstubAllEnvs();
  });

  async function initialize() {
    vi.stubEnv('PGHOST', 'localhost');
    vi.stubEnv('PGDATABASE', 'inventory_test');
    vi.stubEnv('PGUSER', 'inventory_test');
    vi.stubEnv('PGPASSWORD', 'contraseña-sintética');
    await database.onModuleInit();
    client.query.mockClear();
    client.release.mockClear();
  }

  it('sin configuración no crea un pool ni declara readiness saludable', async () => {
    await database.onModuleInit();
    expect(pg.Pool).not.toHaveBeenCalled();
    expect((await database.isHealthy()).healthy).toBe(false);
    await expect(database.query('SELECT 1')).rejects.toThrow(
      /no tiene conexión/,
    );
  });

  it.each(['PGDATABASE', 'PGPASSWORD'])(
    'no sustituye %s ausente por valores implícitos',
    async (missing) => {
      vi.stubEnv('PGHOST', 'localhost');
      vi.stubEnv('PGDATABASE', 'inventory_test');
      vi.stubEnv('PGUSER', 'inventory_test');
      vi.stubEnv('PGPASSWORD', 'contraseña-sintética');
      vi.stubEnv(missing, undefined);
      await database.onModuleInit();
      expect(pg.Pool).not.toHaveBeenCalled();
      expect((await database.isHealthy()).healthy).toBe(false);
    },
  );

  it('confirma la transacción y usa el mismo cliente para todas sus consultas', async () => {
    await initialize();
    const result = await database.transaction(async (tx) => {
      await tx.query('SELECT $1::integer', [7]);
      expect(tx.drizzle).toBeDefined();
      return 'aplicado';
    });
    expect(result).toBe('aplicado');
    expect(client.query.mock.calls).toEqual([
      ['BEGIN'],
      ['SELECT $1::integer', [7]],
      ['COMMIT'],
    ]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('configura límites de consulta y lock; readiness falla y se recupera según la consulta real', async () => {
    await initialize();
    expect(pg.Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
        lock_timeout: 5000,
        query_timeout: 20000,
      }),
    );
    pool.query
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ rows: [{ value: 1 }] });
    expect((await database.isHealthy()).healthy).toBe(false);
    expect((await database.isHealthy()).healthy).toBe(true);
    const errorHandler = pool.on.mock.calls.find(
      ([event]) => event === 'error',
    )?.[1];
    expect(errorHandler).toBeTypeOf('function');
    expect(() =>
      errorHandler(new Error('idle connection closed')),
    ).not.toThrow();
  });

  it('revierte un fallo sin confirmar y siempre libera el cliente', async () => {
    await initialize();
    const failure = new Error('fallo simulado antes de guardar Outbox');
    await expect(
      database.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.query.mock.calls).toEqual([['BEGIN'], ['ROLLBACK']]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('conserva el error original y libera el cliente aunque falle ROLLBACK', async () => {
    await initialize();
    const failure = new Error('fallo original');
    client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('fallo simulado de rollback'));
    await expect(
      database.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
