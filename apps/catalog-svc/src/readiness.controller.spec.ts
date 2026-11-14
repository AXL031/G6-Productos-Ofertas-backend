import { ServiceUnavailableException } from '@nestjs/common';
import { ReadinessController } from './readiness.controller.js';
import type { Database } from './database.js';
import type { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import type { CatalogAmqpRuntime } from './catalog-amqp.js';

describe('Catalog technical readiness', () => {
  const database = { verifyIdentity: vi.fn() } as unknown as Database;
  const repository = {
    checkReadinessAccess: vi.fn(),
  } as unknown as PostgresCatalogRepository;
  const amqp = { required: false, ready: false } as CatalogAmqpRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.verifyIdentity).mockResolvedValue(undefined);
    vi.mocked(repository.checkReadinessAccess).mockResolvedValue(undefined);
  });

  it('checks database identity, required Catalog read permissions, and no commercial data', async () => {
    const controller = new ReadinessController(database, repository, amqp);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ready',
      service: 'catalog-svc',
    });
    expect(database.verifyIdentity).toHaveBeenCalledOnce();
    expect(repository.checkReadinessAccess).toHaveBeenCalledOnce();
  });

  it('fails closed when database verification fails', async () => {
    vi.mocked(database.verifyIdentity).mockRejectedValue(new Error('db down'));
    await expect(
      new ReadinessController(database, repository, amqp).ready(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.checkReadinessAccess).not.toHaveBeenCalled();
  });

  it('fails closed when a required Catalog table permission is unavailable', async () => {
    vi.mocked(repository.checkReadinessAccess).mockRejectedValue(
      new Error('permission denied'),
    );
    await expect(
      new ReadinessController(database, repository, amqp).ready(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed when required AMQP is not ready', async () => {
    await expect(
      new ReadinessController(database, repository, {
        required: true,
        ready: false,
      } as CatalogAmqpRuntime).ready(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.checkReadinessAccess).not.toHaveBeenCalled();
  });

  it('does not require optional AMQP', async () => {
    await expect(
      new ReadinessController(database, repository, amqp).ready(),
    ).resolves.toMatchObject({ status: 'ready' });
  });
});
