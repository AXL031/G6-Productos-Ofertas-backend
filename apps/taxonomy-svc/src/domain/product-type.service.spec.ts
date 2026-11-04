import { describe, expect, it, vi } from 'vitest';
import { Database } from '../database.js';
import { ProductTypeService } from './product-type.service.js';

describe('ProductTypeService', () => {
  it('rechaza entradas vacías y UUID inválido sin consultar la base', async () => {
    const database = new Database();
    const read = vi.spyOn(database, 'read');
    const service = new ProductTypeService(database);
    await expect(service.crear('  ')).resolves.toBeNull();
    await expect(service.obtener('no-uuid')).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('convierte una fila persistida al DTO contractual', async () => {
    const database = new Database();
    vi.spyOn(database, 'read').mockImplementation(async (callback) =>
      callback({
        execute: async () => ({
          rows: [
            {
              id: 'id',
              nombre: 'Calzado',
              estado: 'ACTIVO',
              schema_version: '2',
            },
          ],
        }),
      } as never),
    );
    await expect(
      new ProductTypeService(database).obtener(
        '11111111-1111-4111-8111-111111111111',
      ),
    ).resolves.toEqual({
      tipoProductoId: 'id',
      nombre: 'Calzado',
      estado: 'ACTIVO',
      schemaVersion: 2,
    });
  });
});
