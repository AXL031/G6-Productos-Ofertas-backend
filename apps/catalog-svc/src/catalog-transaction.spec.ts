import {
  CATALOG_POSTGRES_CONFIG,
  Database,
  type CatalogTransaction,
  type PostgresSettings,
} from './database.js';
import { CatalogTransactionManager } from './catalog-transaction.js';
import { Test } from '@nestjs/testing';

describe('CatalogTransactionManager', () => {
  it('is injectable with the shared validated PostgreSQL settings provider', async () => {
    const settings: PostgresSettings = {
      pool: { host: 'isolated.test', port: 5432 },
      expectedRole: 'catalog_app',
      database: 'catalog_test',
      user: 'catalog_app',
      password: 'private-fixture',
      mode: 'direct',
    };
    const module = await Test.createTestingModule({
      providers: [
        Database,
        CatalogTransactionManager,
        { provide: CATALOG_POSTGRES_CONFIG, useValue: settings },
      ],
    }).compile();
    const database = module.get(Database);
    expect(module.get(CatalogTransactionManager)).toBeInstanceOf(
      CatalogTransactionManager,
    );
    expect(Reflect.get(database, 'settings')).toBe(settings);
    await module.close();
  });

  it('delegates the complete operation and transaction options to the shared provider', async () => {
    const tx = {} as CatalogTransaction;
    const result = { committed: true };
    const transaction = vi.fn(
      async (operation: (value: CatalogTransaction) => Promise<unknown>) =>
        operation(tx),
    );
    const manager = new CatalogTransactionManager({
      transaction,
    } as unknown as Database);
    const options = { isolationLevel: 'serializable' as const };
    const operation = vi.fn(async (value: CatalogTransaction) => {
      expect(value).toBe(tx);
      return result;
    });

    await expect(manager.run(operation, options)).resolves.toBe(result);
    expect(transaction).toHaveBeenCalledWith(operation, options);
  });

  it('propagates operation failures so the provider can roll the transaction back', async () => {
    const failure = new Error('domain operation failed');
    const transaction = vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    );
    const manager = new CatalogTransactionManager({
      transaction,
    } as unknown as Database);
    await expect(
      manager.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
