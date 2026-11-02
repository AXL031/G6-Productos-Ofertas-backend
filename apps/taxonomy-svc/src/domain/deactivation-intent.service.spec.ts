import { describe, expect, it, vi } from 'vitest';
import { Database } from '../database.js';
import { DeactivationIntentService } from './deactivation-intent.service.js';
import type { IdentidadBaja } from './deactivation-check.js';

const solicitud: IdentidadBaja = {
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  entityType: 'CATEGORY',
  entityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  version: 0,
};

describe('DeactivationIntentService', () => {
  it('rechaza identidad o versión inválidas antes de acceder a PostgreSQL', async () => {
    const database = new Database();
    const read = vi.spyOn(database, 'read');
    const service = new DeactivationIntentService(database);
    await expect(
      service.registrar({ ...solicitud, operationId: 'incorrecto' }),
    ).resolves.toBe('NO_DISPONIBLE');
    await expect(
      service.registrar({ ...solicitud, version: -1 }),
    ).resolves.toBe('NO_DISPONIBLE');
    await expect(
      service.registrar({
        ...solicitud,
        correlationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).resolves.toBe('NO_DISPONIBLE');
    expect(read).not.toHaveBeenCalled();
  });
  it('no admite tipos sin lectura autoritativa implementada', async () => {
    const database = new Database();
    const read = vi.spyOn(database, 'read');
    await expect(
      new DeactivationIntentService(database).registrar({
        ...solicitud,
        entityType: 'PRODUCT_TYPE',
      }),
    ).resolves.toBe('NO_DISPONIBLE');
    expect(read).not.toHaveBeenCalled();
  });
});
