import { Pool } from 'pg';
import { PricingReadiness } from './pricing-readiness.js';
import { PricingDatabase } from '../persistence/pricing.database.js';
import { validateEnvironment } from '../config/environment.js';

vi.mock('pg', () => ({
  Pool: vi.fn(
    class {
      query = vi.fn();
      end = vi.fn();
      on = vi.fn();
    },
  ),
}));

describe('PricingReadiness', () => {
  it.each(['test', 'production'])(
    'consulta únicamente Pricing, falla cerrado y libera el pool (%s autenticado)',
    async (nodeEnv) => {
      const config = validateEnvironment({
        NODE_ENV: nodeEnv,
        PRICING_SVC_PORT: '3002',
        DATABASE_URL:
          'postgresql://pricing:fixture@localhost/fixture?sslmode=verify-full',
        AUTH_ISSUER: 'https://identity.test',
        AUTH_JWKS_URL: 'https://identity.test/jwks',
      });
      const database = new PricingDatabase(config);
      const readiness = new PricingReadiness(database, config);
      const pool = vi.mocked(Pool).mock.instances.at(-1)!;
      expect(Pool).toHaveBeenLastCalledWith(
        expect.objectContaining({
          max: 2,
          ssl: expect.objectContaining({
            rejectUnauthorized: true,
            checkServerIdentity: expect.any(Function),
          }),
          connectionTimeoutMillis: 2000,
          query_timeout: 2000,
          statement_timeout: 2000,
        }),
      );
      vi.mocked(pool.query).mockImplementationOnce(async () => ({ rows: [] }));
      expect(await readiness.check()).toBe(true);
      expect(pool.query).toHaveBeenCalledWith(
        'SELECT 1 FROM pricing.prices, pricing.price_validities, pricing.scheduled_prices, pricing.bulk_price_jobs, pricing.bulk_price_rows, pricing.outbox LIMIT 0',
      );
      vi.mocked(pool.query).mockRejectedValueOnce(
        new Error('fixture-sensitive-value'),
      );
      expect(await readiness.check()).toBe(false);
      await database.onApplicationShutdown();
      expect(pool.end).toHaveBeenCalledOnce();
      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    },
  );

  it('no anuncia readiness cuando falta la configuración de identidad requerida por HTTP', async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      PRICING_SVC_PORT: '3002',
      DATABASE_URL: 'postgresql://pricing:fixture@localhost/fixture',
    });
    const database = new PricingDatabase(config);
    const readiness = new PricingReadiness(database, config);
    expect(await readiness.check()).toBe(false);
    const pool = vi.mocked(Pool).mock.instances.at(-1)!;
    expect(pool.query).not.toHaveBeenCalled();
    await database.onApplicationShutdown();
  });

  it('pasa TLS explícito al pool sin parámetros URL que puedan degradarlo', async () => {
    const config = validateEnvironment({
      NODE_ENV: 'production',
      PRICING_SVC_PORT: '3002',
      DATABASE_URL:
        'postgresql://pricing:fixture@db.example.invalid/fixture?sslmode=verify-full',
    });
    const database = new PricingDatabase(config);
    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionString:
          'postgresql://pricing:fixture@db.example.invalid/fixture',
        ssl: expect.objectContaining({
          rejectUnauthorized: true,
          checkServerIdentity: expect.any(Function),
        }),
      }),
    );
    await database.onApplicationShutdown();
  });

  it.each(['test', 'production'])(
    'en demo sin G7 comprueba PostgreSQL y conserva el fallo cerrado (%s)',
    async (nodeEnv) => {
      const config = validateEnvironment({
        NODE_ENV: nodeEnv,
        PRICING_SVC_PORT: '3002',
        DATABASE_URL:
          'postgresql://pricing:fixture@localhost/fixture?sslmode=verify-full',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        PRICING_DEMO_PRODUCTION_CONFIRMED:
          nodeEnv === 'production' ? 'true' : undefined,
      });
      const database = new PricingDatabase(config);
      const readiness = new PricingReadiness(database, config);
      const pool = vi.mocked(Pool).mock.instances.at(-1)!;
      vi.mocked(pool.query).mockImplementationOnce(async () => ({ rows: [] }));
      expect(await readiness.check()).toBe(true);
      expect(pool.query).toHaveBeenCalledOnce();
      vi.mocked(pool.query).mockRejectedValueOnce(new Error('DB unavailable'));
      expect(await readiness.check()).toBe(false);
      await database.onApplicationShutdown();
    },
  );
});
