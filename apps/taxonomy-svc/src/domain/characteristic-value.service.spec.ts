import { describe, expect, it, vi } from 'vitest';
import { Database } from '../database.js';
import { CharacteristicValueService } from './characteristic-value.service.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('CharacteristicValueService', () => {
  it.each(['TEXTO', 'NUMERO'])(
    'rechaza valores predefinidos para %s',
    async (tipo) => {
      const execute = vi
        .fn()
        .mockResolvedValue({ rows: [{ tipo, estado: 'ACTIVO' }] });
      const database = new Database();
      vi.spyOn(database, 'read').mockImplementation(async (callback) =>
        callback({
          transaction: async (f: (tx: unknown) => unknown) => f({ execute }),
        } as never),
      );
      await expect(
        new CharacteristicValueService(database).crear(id, 'Rojo'),
      ).resolves.toEqual({ estado: 'INVALIDO' });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('rechaza la modificación con versión obsoleta antes de escribir', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tipo: 'LISTA', estado: 'ACTIVO' }] })
      .mockResolvedValueOnce({
        rows: [{ id, nombre: 'Rojo', estado: 'ACTIVO', taxonomy_version: 2 }],
      });
    const database = new Database();
    vi.spyOn(database, 'read').mockImplementation(async (callback) =>
      callback({
        transaction: async (f: (tx: unknown) => unknown) => f({ execute }),
      } as never),
    );
    await expect(
      new CharacteristicValueService(database).actualizar(id, id, 'Azul', 1),
    ).resolves.toEqual({ estado: 'VERSION_CONFLICT' });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
