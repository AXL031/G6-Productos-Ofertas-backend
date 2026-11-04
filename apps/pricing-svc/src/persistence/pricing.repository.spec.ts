import { Client, DatabaseError, Pool } from 'pg';
import { PricingDatabase } from './pricing.database.js';
import { PricingRepository } from './pricing.repository.js';
import { PricingPersistenceError } from './persistence.error.js';
import { prices } from './pricing.schema.js';

describe('PricingRepository: transacciones Drizzle', () => {
  afterEach(() => vi.restoreAllMocks());
  const config = {
    nodeEnv: 'test' as const,
    port: 3002,
    databaseUrl: 'postgresql://pricing:fixture@localhost/fixture',
    databaseSsl: false as const,
  };

  function setup() {
    const database = new PricingDatabase(config);
    const client = Object.assign(new Client(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => client);
    return { database, client, repository: new PricingRepository(database) };
  }

  it('oculta errores de conexión previos al callback, incluidos TLS y timeouts', async () => {
    const { repository } = setup();
    vi.mocked(Pool.prototype.connect).mockRejectedValueOnce(
      new Error('fixture-sensitive-tls-host'),
    );
    const callback = vi.fn();
    const error = await repository
      .transaction(callback)
      .catch((e: unknown) => e);
    expect(callback).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(PricingPersistenceError);
    expect(String(error)).not.toContain('fixture-sensitive-tls-host');
  });

  it('BEGIN/COMMIT usa una conexión, devuelve el resultado y la libera', async () => {
    const { client, repository } = setup();
    const result = await repository.transaction(async (tx) => {
      await tx.insert(prices).values({ productId: 'fixture' });
      return 'confirmado';
    });
    expect(result).toBe('confirmado');
    expect(
      client.query.mock.calls.map(([query]) =>
        typeof query === 'string' ? query : query.text,
      ),
    ).toEqual([
      'begin',
      expect.stringContaining('insert into "pricing"."prices"'),
      'commit',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('readImport limita filas y solo selecciona campos de respuesta, nunca row_input', async () => {
    const { client, repository } = setup();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          ['4d96e3ac-cd5b-4ce7-9b8d-e8dc3f93313b', 'QUEUED', false, 0, 0, 0],
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    await repository.readImport('4d96e3ac-cd5b-4ce7-9b8d-e8dc3f93313b');
    const selects = client.query.mock.calls
      .map(([query]) => (typeof query === 'string' ? query : query.text))
      .filter((query) => query.startsWith('select'));
    expect(selects).toHaveLength(2);
    expect(selects[1]).toMatch(/^select "row_id", "sku", "status", "code"/);
    expect(selects[1]).toContain('limit');
    expect(selects.join(' ')).not.toMatch(
      /row_input|detail|report_uri|usuario_id|created_at|updated_at/,
    );
  });

  it('un error del caso de uso produce ROLLBACK y conserva su identidad', async () => {
    const { client, repository } = setup();
    const failure = new Error('rechazo del caso de uso');
    await expect(
      repository.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      client.query.mock.calls.map(([query]) =>
        typeof query === 'string' ? query : query.text,
      ),
    ).toEqual(['begin', 'rollback']);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('un fallo diferido en COMMIT hace ROLLBACK y oculta SQL/datos/credenciales', async () => {
    const { client, repository } = setup();
    const failure = new DatabaseError('fixture-sensitive-value', 0, 'error');
    failure.code = '23514';
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(failure);
    const error = await repository
      .transaction(async () => 'resultado')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PricingPersistenceError);
    expect(error).toMatchObject({ sqlState: '23514' });
    expect(String(error)).not.toContain('fixture-sensitive-value');
    expect(
      client.query.mock.calls.map(([query]) =>
        typeof query === 'string' ? query : query.text,
      ),
    ).toEqual(['begin', 'commit', 'rollback']);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
