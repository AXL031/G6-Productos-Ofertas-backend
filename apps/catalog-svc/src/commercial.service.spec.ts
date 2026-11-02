import { ForbiddenException } from '@nestjs/common';
import { CommercialService } from './commercial.service.js';
import type { ProductQuery } from './commercial.types.js';

describe('CommercialService', () => {
  const repository = {
    listCandidates: vi.fn(),
    findCandidateBySlug: vi.fn(),
    findCandidateByProductId: vi.fn(),
    priceCandidates: vi.fn(),
  };
  const taxonomy = { category: vi.fn(), brand: vi.fn() };
  const service = new CommercialService(repository as never, taxonomy as never);
  const query: ProductQuery = {
    canal: 'RETAIL',
    pagina: 1,
    tamanio: 20,
    orden: 'NOMBRE_ASC',
  };

  beforeEach(() => vi.clearAllMocks());

  it('passes channel context to the globally eligible product read', async () => {
    repository.findCandidateByProductId.mockResolvedValue({
      product_id: 'p-1',
      marca_id: 'brand-1',
    });
    taxonomy.brand.mockResolvedValue({ marca_id: 'brand-1', name: 'Brand' });
    await service.productById('p-1', 'RETAIL');
    expect(repository.findCandidateByProductId).toHaveBeenCalledWith(
      'p-1',
      'RETAIL',
    );
  });

  it('allows inactive administrative listing only when the caller is authorized', async () => {
    const adminQuery = { ...query, estado: 'INACTIVO' as const };
    repository.listCandidates.mockResolvedValue({ items: [], total: 0 });
    await expect(service.list(adminQuery, undefined, true)).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(repository.listCandidates).toHaveBeenCalledWith(adminQuery);
    await expect(service.list(adminQuery)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('queries global eligibility without a separate channel selection', async () => {
    repository.listCandidates.mockResolvedValue({ items: [], total: 0 });
    await service.list(query);
    expect(repository.listCandidates).toHaveBeenCalledWith(query);
  });

  it('evaluates the complete lightweight candidate set before the SQL product count/page', async () => {
    const candidates = Array.from({ length: 250 }, (_, i) => ({
      productId: 'p' + i,
      sku: 's' + i,
    }));
    repository.priceCandidates.mockResolvedValue(candidates);
    repository.listCandidates.mockResolvedValue({
      items: [{ product_id: 'p150' }],
      total: 1,
    });
    const filter = { matchingProducts: vi.fn(async () => ['p150']) };
    const priced = new CommercialService(
      repository as never,
      taxonomy as never,
      { enabled: false },
      undefined,
      undefined,
      filter as never,
    );
    const request = {
      ...query,
      pagina: 2,
      tamanio: 1,
      precioMin: '80',
      precioMax: '100',
    };
    await priced.list(request, 'correlation');
    expect(filter.matchingProducts).toHaveBeenCalledWith(
      candidates,
      request,
      'correlation',
    );
    expect(repository.listCandidates).toHaveBeenCalledWith(
      { ...request, precioMin: undefined, precioMax: undefined },
      false,
      ['p150'],
    );
    expect(repository.priceCandidates.mock.invocationCallOrder[0]).toBeLessThan(
      repository.listCandidates.mock.invocationCallOrder[0],
    );
  });

  it('preserves administrative non-active monetary queries as unavailable until their own policy is defined', async () => {
    await expect(
      service.list(
        { ...query, estado: 'BORRADOR', precioMin: '1' },
        undefined,
        true,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(repository.priceCandidates).not.toHaveBeenCalled();
  });
});
