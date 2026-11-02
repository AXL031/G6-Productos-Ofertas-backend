import { BarcodeService } from './barcode.service.js';
import { BarcodeRepository } from './barcode.repository.js';
import { CatalogTokenVerifier, type CatalogPrincipal } from './catalog-auth.js';

describe('D-CAT-01..04 authorization and commercial results', () => {
  const repository = {
    resolve: vi.fn(),
    register: vi.fn(),
    list: vi.fn(),
    retire: vi.fn(),
  };
  const verifier = { verify: vi.fn() };
  const service = new BarcodeService(
    repository as unknown as BarcodeRepository,
    verifier as unknown as CatalogTokenVerifier,
  );
  beforeEach(() => {
    vi.resetAllMocks();
    verifier.verify.mockResolvedValue({
      kind: 'user',
      subject: 'verified-actor',
      roles: ['GESTOR_COMERCIAL'],
    });
  });
  it('preserves opaque barcode text including zeros, spaces and nonnumeric symbols', async () => {
    repository.resolve.mockResolvedValue('000-SKU');
    expect(await service.resolve(' 000-AB/é ')).toEqual({ sku: '000-SKU' });
    expect(repository.resolve).toHaveBeenCalledWith(' 000-AB/é ');
  });
  it('distinguishes missing/noncommercial codes from technical failures', async () => {
    repository.resolve.mockResolvedValue(null);
    await expect(service.resolve('missing')).rejects.toMatchObject({
      status: 404,
      response: { code: 'CODIGO_BARRAS_NO_ENCONTRADO' },
    });
    repository.resolve.mockRejectedValue(new Error('private database details'));
    await expect(service.resolve('missing')).rejects.toMatchObject({
      status: 503,
    });
  });
  it('uses the JWT actor for register/list/retire instead of trusting command data', async () => {
    await service.administer(
      { operation: 'register', sku: 'S', codigo_barras: '0001' },
      'Bearer fixture',
    );
    await service.administer({ operation: 'list', sku: 'S' }, 'Bearer fixture');
    await service.administer(
      { operation: 'retire', codigo_barras: '0001' },
      'Bearer fixture',
    );
    expect(repository.register).toHaveBeenCalledWith(
      '0001',
      'S',
      'verified-actor',
    );
    expect(repository.list).toHaveBeenCalledWith('S');
    expect(repository.retire).toHaveBeenCalledWith('0001', 'verified-actor');
  });
  it.each<CatalogPrincipal>([
    {
      kind: 'service',
      subject: 'modulo-retail',
      scopes: ['catalogo:leer'],
      audiences: ['api-productos'],
    },
    { kind: 'user', subject: 'actor', roles: [] },
  ])(
    'rejects administration by unauthorized identity %j',
    async (principal) => {
      verifier.verify.mockResolvedValue(principal);
      await expect(
        service.administer(
          { operation: 'register', sku: 'S', codigo_barras: 'x' },
          'Bearer fixture',
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.register).not.toHaveBeenCalled();
    },
  );
});
