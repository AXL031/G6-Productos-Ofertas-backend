import { approvedCatalogProductPolicy } from './catalog-product.policy.js';
describe('Approved initial catalog product policy', () => {
  it('uses the user-approved PEN intent and normalized name plus UUID slug', async () => {
    await expect(
      approvedCatalogProductPolicy.resolve(
        { nombre: '  Pólo Deportivo Ázul  ' },
        '00000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toEqual({
      slug: 'polo-deportivo-azul-00000000-0000-4000-8000-000000000001',
      moneda: 'PEN',
    });
  });
  it('keeps identifiers distinct when the name contains no URL letters', async () => {
    await expect(
      approvedCatalogProductPolicy.resolve(
        { nombre: '---' },
        '00000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toMatchObject({
      slug: 'producto-00000000-0000-4000-8000-000000000001',
    });
  });
});
