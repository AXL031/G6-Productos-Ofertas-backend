import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HistoricalRecoveryService,
  HISTORICAL_RECOVERY_CAPABILITY,
  parseHistoricalSelection,
  readHistoricalRecoveryCapabilities,
} from './historical-recovery.service.js';
import { CatalogTransactionManager } from './catalog-transaction.js';
import { PostgresCatalogWriteRepository } from './postgres-catalog-write.repository.js';

describe('Historical recovery candidate admission boundary', () => {
  it('denies capability by default and grants only the configured subject and exact capability', () => {
    const subject = randomUUID();
    expect(
      readHistoricalRecoveryCapabilities({}).allows(
        subject,
        HISTORICAL_RECOVERY_CAPABILITY,
      ),
    ).toBe(false);
    const capabilities = readHistoricalRecoveryCapabilities({
      CATALOG_HISTORICAL_RECOVERY_ALLOWED_SUBJECTS: subject,
    });
    expect(
      capabilities.allows(
        subject.toUpperCase(),
        HISTORICAL_RECOVERY_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      capabilities.allows(randomUUID(), HISTORICAL_RECOVERY_CAPABILITY),
    ).toBe(false);
    for (const invalid of ['*', subject + ',' + subject, ' '])
      expect(() =>
        readHistoricalRecoveryCapabilities({
          CATALOG_HISTORICAL_RECOVERY_ALLOWED_SUBJECTS: invalid,
        }),
      ).toThrow();
  });
  it.each([
    {},
    { solicitudId: randomUUID(), dependencias: [] },
    { solicitudId: randomUUID(), dependencias: ['INVENTARIO', 'INVENTARIO'] },
    {
      solicitudId: randomUUID(),
      dependencias: ['INVENTARIO'],
      precio_regular: 20,
    },
    {
      solicitudId: randomUUID(),
      dependencias: ['INVENTARIO'],
      default_location_id: randomUUID(),
    },
    {
      solicitudId: randomUUID(),
      dependencias: ['PRICING'],
      variantIds: [randomUUID()],
    },
  ])(
    'rejects inferred/ambiguous selections and monetary or location inputs %j',
    (body) => {
      expect(() => parseHistoricalSelection(body)).toThrow();
    },
  );
  it('normalizes textual UUID and selection order without deriving dependences', () => {
    const id = randomUUID();
    const child = randomUUID();
    expect(
      parseHistoricalSelection({
        solicitudId: id.toUpperCase(),
        dependencias: ['PRICING', 'INVENTARIO'],
        variantIds: [child],
      }),
    ).toEqual({
      solicitudId: id,
      dependencias: ['INVENTARIO', 'PRICING'],
      variantIds: [child],
    });
  });
  it('rejects missing capability before persistence and blocks only Pricing emission without creating an intent', async () => {
    const transactions = Object.create(
      CatalogTransactionManager.prototype,
    ) as CatalogTransactionManager;
    const run = vi.spyOn(transactions, 'run');
    const repository = new PostgresCatalogWriteRepository();
    const actor = { subject: randomUUID(), correlationId: randomUUID() };
    const denied = new HistoricalRecoveryService(
      transactions,
      repository,
      readHistoricalRecoveryCapabilities({}),
    );
    await expect(
      denied.recover(randomUUID(), {}, actor),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const allowed = new HistoricalRecoveryService(
      transactions,
      repository,
      readHistoricalRecoveryCapabilities({
        CATALOG_HISTORICAL_RECOVERY_ALLOWED_SUBJECTS: actor.subject,
      }),
    );
    await expect(
      allowed.recover(
        randomUUID(),
        { solicitudId: randomUUID(), dependencias: ['PRICING', 'INVENTARIO'] },
        actor,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(run).not.toHaveBeenCalled();
  });
});
