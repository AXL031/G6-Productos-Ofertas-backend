import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CatalogQueryService,
  parseVariantPage,
} from './catalog-query.service.js';

describe('CatalogQueryService', () => {
  const repository = {
    physicalData: vi.fn(),
    productPreparation: vi.fn(),
    listVariants: vi.fn(),
    findVariant: vi.fn(),
  };
  const commercial = { productById: vi.fn() };
  const service = new CatalogQueryService(
    repository as never,
    commercial as never,
  );

  beforeEach(() => vi.clearAllMocks());

  it('routes product queries through the commercial channel policy', async () => {
    commercial.productById.mockResolvedValue({ product_id: 'p-1' });
    await expect(
      service.product('p-1', 'RETAIL', 'correlation'),
    ).resolves.toEqual({
      product_id: 'p-1',
    });
    expect(commercial.productById).toHaveBeenCalledWith(
      'p-1',
      'RETAIL',
      'correlation',
      undefined,
    );
    expect(() => service.product('p-1', 'UNKNOWN')).toThrow(
      BadRequestException,
    );
  });

  it('validates physical SKU batches and preserves opaque SKU strings', async () => {
    const result = { productos: [], noEncontrados: ['0000123'] };
    repository.physicalData.mockResolvedValue(result);
    await expect(service.physicalData({ skus: ['0000123'] })).resolves.toEqual(
      result,
    );
    expect(repository.physicalData).toHaveBeenCalledWith(['0000123']);
    await expect(service.physicalData({ skus: [] })).rejects.toMatchObject({
      status: 422,
    });
    await expect(service.physicalData({ skus: [''] })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      service.physicalData({ skus: Array(101).fill('sku') }),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(service.physicalData(null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('permits absent channel only for a verified human identity', async () => {
    commercial.productById.mockResolvedValue({ product_id: 'p-1' });
    await service.product('p-1', undefined, 'correlation', { user: true });
    expect(commercial.productById).toHaveBeenCalledWith(
      'p-1',
      undefined,
      'correlation',
      { user: true },
    );
    expect(() => service.product('p-1', undefined)).toThrow(
      BadRequestException,
    );
    expect(() =>
      service.product('p-1', undefined, undefined, { user: false }),
    ).toThrow(BadRequestException);
  });

  it('returns the declared 404 codes for missing product and variant', async () => {
    repository.productPreparation.mockResolvedValue(null);
    repository.listVariants.mockResolvedValue(null);
    repository.findVariant.mockResolvedValue(null);
    await expect(service.preparation('missing')).rejects.toMatchObject({
      response: { code: 'PRODUCTO_NO_ENCONTRADO' },
      status: 404,
    });
    await expect(service.variants('missing', {})).rejects.toMatchObject({
      response: { code: 'PRODUCTO_NO_ENCONTRADO' },
      status: 404,
    });
    await expect(service.variant('p-1', 'missing')).rejects.toMatchObject({
      response: { code: 'VARIANTE_NO_ENCONTRADA' },
      status: 404,
    });
  });

  it('validates variant pagination and status filters', async () => {
    repository.listVariants.mockResolvedValue({ items: [], meta: {} });
    await service.variants('p-1', {
      pagina: '2',
      tamanio: '200',
      estado: 'ACTIVA',
    });
    expect(repository.listVariants).toHaveBeenCalledWith(
      'p-1',
      2,
      200,
      'ACTIVA',
    );
    for (const invalid of [
      { pagina: '0' },
      { tamanio: '201' },
      { estado: 'ACTIVO' },
      { extra: '1' },
      { pagina: 2 },
    ])
      expect(() => parseVariantPage(invalid)).toThrow(BadRequestException);
  });

  it('validates opaque barcode input and keeps D-CAT-01..04 fail-closed', () => {
    expect(() =>
      service.resolveBarcode({ codigo_barras: '0000123456789' }),
    ).toThrow(ServiceUnavailableException);
    expect(() => service.resolveBarcode({ codigo_barras: '' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      service.resolveBarcode({
        codigo_barras: '0000123456789',
        sku: 'spoofed',
      }),
    ).toThrow(BadRequestException);
  });
});
