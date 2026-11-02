import { CatalogMutationService } from './catalog-mutation.service.js';

describe('Catalog mutation contract boundaries', () => {
  const transactions = { run: vi.fn() };
  const service = new CatalogMutationService(
    transactions as never,
    {} as never,
    {} as never,
  );
  beforeEach(() => vi.clearAllMocks());
  it('does not persist a product using an invented currency or slug policy', async () => {
    await expect(
      service.createProduct(
        {
          nombre: 'Fixture',
          descripcion: 'Draft',
          categoriaId: 'cat',
          tipoProductoId: 'type',
          marcaId: 'brand',
          skuBase: '0000123',
          tieneVariantes: false,
          precioBaseInicial: 10,
        },
        {
          authorization: 'Bearer fixture',
          correlationId: '00000000-0000-4000-8000-000000000001',
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(transactions.run).not.toHaveBeenCalled();
  });
  it('rejects changes to commercial identity before opening a transaction', async () => {
    await expect(
      service.update(
        'p',
        undefined,
        { skuBase: 'other' },
        {
          authorization: 'Bearer fixture',
          correlationId: '00000000-0000-4000-8000-000000000001',
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO' },
    });
    expect(transactions.run).not.toHaveBeenCalled();
  });
});
