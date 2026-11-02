import { HttpException } from '@nestjs/common';
import { CatalogMutationService } from './catalog-mutation.service.js';

describe('Q-06 type correction before first publication', () => {
  const actor = {
    authorization: 'Bearer fixture',
    correlationId: '00000000-0000-4000-8000-000000000001',
  };
  function fixture(patch: Record<string, unknown> = {}) {
    let row = {
      id: '00000000-0000-4000-8000-000000000002',
      nombre: 'Name',
      descripcion: 'Description',
      categoria_id: 'category',
      marca_id: 'brand',
      tipo_producto_id: 'old',
      estado: 'BORRADOR',
      sku_base: '000-SKU',
      slug: 'stable',
      tiene_variantes: false,
      publicado_alguna_vez: false,
      catalog_version: 3n,
      attributes: [
        {
          caracteristica_id: 'material',
          nombre_snapshot: 'Material',
          valor_id: null,
          valor: 'cotton',
        },
      ],
      children: [],
      images: [],
      profile: null,
      checks: [],
      ...patch,
    };
    const set = vi.fn((values: Record<string, unknown>) => {
      row = { ...row, ...values };
      return { where: () => ({ returning: async () => [row] }) };
    });
    const tx = {
      execute: vi.fn(),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      update: () => ({ set }),
    };
    const repository = {
      lockProduct: async () => row,
      aggregate: async () => row,
      replaceProductCollections: vi.fn(async () => undefined),
    };
    const masters = {
      masters: vi.fn(async () => ({ schemaVersion: 7 })),
      attributes: vi.fn(async (_type: string, values: unknown[]) => values),
    };
    const service = new CatalogMutationService(
      { run: async (work: (t: unknown) => unknown) => work(tx) } as never,
      repository as never,
      masters as never,
    );
    return { service, repository, masters, set, tx };
  }
  it('validates the whole retained collection against the new version and preserves identity', async () => {
    const f = fixture();
    const result = await f.service.update(
      'p',
      undefined,
      { tipoProductoId: 'new', catalogVersion: 3 },
      actor,
    );
    expect(result).toMatchObject({
      product_id: '00000000-0000-4000-8000-000000000002',
      sku_base: '000-SKU',
      slug: 'stable',
      tipo_producto_id: 'new',
    });
    expect(f.masters.attributes).toHaveBeenCalledWith(
      'new',
      [
        {
          caracteristica_id: 'material',
          nombre: 'Material',
          valor_id: null,
          valor: 'cotton',
        },
      ],
      false,
      actor.authorization,
      actor.correlationId,
      7,
    );
    expect(f.repository.replaceProductCollections).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        atributos: [expect.objectContaining({ valor: 'cotton' })],
      }),
    );
  });
  it.each([
    { estado: 'ACTIVO' },
    { estado: 'INACTIVO' },
    { tiene_variantes: true },
    { children: [{ id: 'unexpected-persisted-child' }] },
    { publicado_alguna_vez: true },
    { publicado_alguna_vez: null },
  ])(
    'rejects structural/publication preconditions %j before writes',
    async (patch) => {
      const f = fixture(patch);
      await expect(
        f.service.update(
          'p',
          undefined,
          { tipoProductoId: 'new', catalogVersion: 3 },
          actor,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO' },
      });
      expect(f.set).not.toHaveBeenCalled();
      expect(f.masters.masters).not.toHaveBeenCalled();
    },
  );
  it('requires the correction version and rejects stale versions', async () => {
    const f = fixture();
    await expect(
      f.service.update('p', undefined, { tipoProductoId: 'new' }, actor),
    ).rejects.toMatchObject({ status: 400, response: { code: 'VALIDACION' } });
    await expect(
      f.service.update(
        'p',
        undefined,
        { tipoProductoId: 'new', catalogVersion: 2 },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'VERSION_CONFLICT' },
    });
    expect(f.set).not.toHaveBeenCalled();
  });
  it('rejects incompatible retained attributes without deleting and permits an explicit corrected collection', async () => {
    const f = fixture();
    f.masters.attributes.mockRejectedValueOnce(
      new HttpException({ code: 'ATRIBUTO_IDENTIFICADOR_INVALIDO' }, 422),
    );
    await expect(
      f.service.update(
        'p',
        undefined,
        { tipoProductoId: 'new', catalogVersion: 3 },
        actor,
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: 'VALIDACION' } });
    expect(f.repository.replaceProductCollections).not.toHaveBeenCalled();
    await f.service.update(
      'p',
      undefined,
      { tipoProductoId: 'new', catalogVersion: 3, atributos: [] },
      actor,
    );
    expect(f.masters.attributes).toHaveBeenLastCalledWith(
      'new',
      [],
      false,
      actor.authorization,
      actor.correlationId,
      7,
    );
  });
  it('preserves TIPO_PRODUCTO_INVALIDO 422 and dependency failure 503', async () => {
    for (const [status, code] of [
      [422, 'TIPO_PRODUCTO_INVALIDO'],
      [503, 'SERVICIO_NO_DISPONIBLE'],
    ] as const) {
      const f = fixture();
      f.masters.masters.mockRejectedValueOnce(
        new HttpException({ code }, status),
      );
      await expect(
        f.service.update(
          'p',
          undefined,
          { tipoProductoId: 'new', catalogVersion: 3 },
          actor,
        ),
      ).rejects.toMatchObject({ status, response: { code } });
      expect(f.set).not.toHaveBeenCalled();
    }
  });
});
