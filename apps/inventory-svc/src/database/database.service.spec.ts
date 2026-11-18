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

  it('falla el arranque productivo si faltan credenciales PostgreSQL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(database.onModuleInit()).rejects.toThrow(
      /PostgreSQL o el esquema requerido/,
    );
    expect(pg.Pool).not.toHaveBeenCalled();
    expect((await database.isHealthy()).healthy).toBe(false);
  });

  it('falla el arranque productivo si la conexión inicial no está disponible', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PGHOST', 'db.example');
    vi.stubEnv('PGDATABASE', 'inventory_test');
    vi.stubEnv('PGUSER', 'inventory_test');
    vi.stubEnv('PGPASSWORD', 'secret-test-only');
    pool.connect.mockRejectedValueOnce(new Error('secret DSN must not appear'));
    await expect(database.onModuleInit()).rejects.toThrow(
      /PostgreSQL o el esquema requerido/,
    );
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('falla el preflight si faltan columnas de las tablas de Inventory requeridas', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PGHOST', 'db.example');
    vi.stubEnv('PGDATABASE', 'inventory_test');
    vi.stubEnv('PGUSER', 'inventory_test');
    vi.stubEnv('PGPASSWORD', 'secret-test-only');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(database.onModuleInit()).rejects.toThrow(
      /PostgreSQL o el esquema requerido/,
    );
    expect((await database.isHealthy()).healthy).toBe(false);
    expect(pool.end).toHaveBeenCalledTimes(1);
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
        options: '-c search_path=inventory,public',
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

  describe('Validación obligatoria del esquema H5 (MESSAGING_PROVIDER=AZURE_SERVICE_BUS)', () => {
    const h5Columns = [
      'message_id',
      'destination',
      'route_version',
      'transport',
      'created_at',
      'next_attempt_at',
      'attempts',
      'lease_token',
      'lease_until',
      'sent_at',
      'last_error',
    ].map((column_name) => ({ column_name }));

    function setupH5Env() {
      vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
      vi.stubEnv('G6_SERVICE_BUS_PILOT_ENABLED', 'true');
      vi.stubEnv('INVENTORY_SERVICE_BUS_PUBLISH_ENABLED', 'true');
      vi.stubEnv('INVENTORY_SERVICE_BUS_CONSUME_ENABLED', 'true');
      vi.stubEnv(
        'SERVICE_BUS_NAMESPACE_FQDN',
        'g6-pilot-inventory.servicebus.windows.net',
      );
      vi.stubEnv('PGHOST', 'localhost');
      vi.stubEnv('PGDATABASE', 'inventory_test');
      vi.stubEnv('PGUSER', 'inventory_test');
      vi.stubEnv('PGPASSWORD', 'contraseña-sintética');
    }

    it('falla el arranque incluso en desarrollo si H5 está seleccionado y PostgreSQL no está configurado', async () => {
      vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
      vi.stubEnv('G6_SERVICE_BUS_PILOT_ENABLED', 'true');
      vi.stubEnv('INVENTORY_SERVICE_BUS_PUBLISH_ENABLED', 'true');
      vi.stubEnv('INVENTORY_SERVICE_BUS_CONSUME_ENABLED', 'true');
      vi.stubEnv(
        'SERVICE_BUS_NAMESPACE_FQDN',
        'g6-pilot-inventory.servicebus.windows.net',
      );
      vi.stubEnv('NODE_ENV', 'development');

      await expect(database.onModuleInit()).rejects.toThrow(
        /PostgreSQL o el esquema requerido de Inventory no está preparado/,
      );
      expect(pg.Pool).not.toHaveBeenCalled();
    });

    it('falla el arranque si faltan columnas requeridas en inventory.outbox_delivery', async () => {
      setupH5Env();
      // SELECT 1
      client.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      // information_schema.columns (falta 'last_error')
      client.query.mockResolvedValueOnce({
        rows: h5Columns.slice(0, 10),
      });

      await expect(database.onModuleInit()).rejects.toThrow(
        /PostgreSQL o el esquema requerido/,
      );
    });

    it('falla el arranque si la Primary Key de outbox_delivery no es (message_id, destination)', async () => {
      setupH5Env();
      client.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      client.query.mockResolvedValueOnce({ rows: h5Columns });
      // PK solo con message_id
      client.query.mockResolvedValueOnce({
        rows: [{ column_name: 'message_id' }],
      });

      await expect(database.onModuleInit()).rejects.toThrow(
        /PostgreSQL o el esquema requerido/,
      );
    });

    it('falla el arranque si falta la Foreign Key contra inventory.outbox(event_id)', async () => {
      setupH5Env();
      client.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      client.query.mockResolvedValueOnce({ rows: h5Columns });
      client.query.mockResolvedValueOnce({
        rows: [{ column_name: 'message_id' }, { column_name: 'destination' }],
      });
      // FK ausente
      client.query.mockResolvedValueOnce({ rows: [] });

      await expect(database.onModuleInit()).rejects.toThrow(
        /PostgreSQL o el esquema requerido/,
      );
    });

    it('falla el arranque si el usuario carece de permisos SELECT, INSERT o UPDATE', async () => {
      setupH5Env();
      client.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      client.query.mockResolvedValueOnce({ rows: h5Columns });
      client.query.mockResolvedValueOnce({
        rows: [{ column_name: 'message_id' }, { column_name: 'destination' }],
      });
      client.query.mockResolvedValueOnce({
        rows: [
          {
            column_name: 'message_id',
            foreign_table_schema: 'inventory',
            foreign_table_name: 'outbox',
            foreign_column_name: 'event_id',
          },
        ],
      });
      // can_update: false
      client.query.mockResolvedValueOnce({
        rows: [{ can_select: true, can_insert: true, can_update: false }],
      });

      await expect(database.onModuleInit()).rejects.toThrow(
        /PostgreSQL o el esquema requerido/,
      );
    });

    it('inicia correctamente cuando la tabla outbox_delivery y sus permisos están íntegros', async () => {
      setupH5Env();
      client.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      client.query.mockResolvedValueOnce({ rows: h5Columns });
      client.query.mockResolvedValueOnce({
        rows: [{ column_name: 'message_id' }, { column_name: 'destination' }],
      });
      client.query.mockResolvedValueOnce({
        rows: [
          {
            column_name: 'message_id',
            foreign_table_schema: 'inventory',
            foreign_table_name: 'outbox',
            foreign_column_name: 'event_id',
          },
        ],
      });
      client.query.mockResolvedValueOnce({
        rows: [{ can_select: true, can_insert: true, can_update: true }],
      });

      await expect(database.onModuleInit()).resolves.toBeUndefined();
      expect((await database.isHealthy()).healthy).toBe(true);
    });
  });
});
