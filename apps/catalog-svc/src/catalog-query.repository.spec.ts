import { CatalogQueryRepository } from './catalog-query.repository.js';
import type {
  Database,
  CatalogDatabase,
  CatalogTransaction,
} from './database.js';

// Query-result fixtures cover invalid legacy data not representable by current SQL constraints.
function row(sku = '000AbC,/ñ') {
  return {
    sku,
    identityId: 'identity',
    variantId: null as string | null,
    productId: 'product',
    productHasVariants: false,
    productStatus: 'BORRADOR',
    variantStatus: null as string | null,
    weight: '1.5',
    length: '10',
    width: '20',
    height: '30',
    profileUpdatedAt: new Date('2026-11-02T12:00:00.000Z'),
  };
}
function repositoryWith(rows: unknown[]) {
  const query = {
    from: () => query,
    leftJoin: () => query,
    where: async () => rows,
  };
  const tx = { select: () => query } as unknown as CatalogTransaction;
  const db = {
    transaction: async (work: (tx: CatalogTransaction) => unknown) => work(tx),
  } as unknown as CatalogDatabase;
  const database = {
    read: async (work: (db: CatalogDatabase) => unknown) => work(db),
  } as unknown as Database;
  return new CatalogQueryRepository(database);
}
describe('OPEN-09 physical repository (query-result fixtures)', () => {
  it.each(['ACTIVO', 'INACTIVO', 'BORRADOR'])(
    'preserves simple SKU in state %s',
    async (state) => {
      const sample = { ...row(), productStatus: state };
      await expect(
        repositoryWith([sample]).physicalData([sample.sku, 'missing']),
      ).resolves.toEqual({
        productos: [
          {
            sku: sample.sku,
            estado: state,
            pesoKg: 1.5,
            dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
            actualizadoEn: sample.profileUpdatedAt.toISOString(),
          },
        ],
        noEncontrados: ['missing'],
      });
    },
  );
  it.each([
    ['ACTIVA', 'ACTIVO'],
    ['INACTIVA', 'INACTIVO'],
    ['BORRADOR', 'BORRADOR'],
  ])(
    'maps variant state %s to %s under an active parent',
    async (variantStatus, estado) => {
      const sample = {
        ...row(),
        variantId: 'variant',
        productHasVariants: true,
        productStatus: 'ACTIVO',
        variantStatus,
      };
      await expect(
        repositoryWith([sample]).physicalData([sample.sku]),
      ).resolves.toMatchObject({ productos: [{ estado }], noEncontrados: [] });
    },
  );
  it.each(['ACTIVO', 'INACTIVO', 'BORRADOR'])(
    'D-G2-01 projects effective state under parent %s without mutating either entity',
    async (productStatus) => {
      for (const [variantStatus, expected] of [
        ['ACTIVA', productStatus],
        ['INACTIVA', 'INACTIVO'],
        ['BORRADOR', 'BORRADOR'],
      ]) {
        const sample = {
          ...row(),
          variantId: 'variant',
          productHasVariants: true,
          productStatus,
          variantStatus,
        };
        const before = { ...sample };
        const result = await repositoryWith([sample]).physicalData([
          sample.sku,
        ]);
        expect(result.productos[0].estado).toBe(expected);
        expect(result.noEncontrados).toEqual([]);
        expect(sample).toEqual(before);
      }
    },
  );
  it.each([
    { skus: ['base'], affected: ['base'] },
    { skus: ['valid', 'base', 'missing'], affected: ['base'] },
    { skus: ['bad', 'base'], affected: ['base'] },
    { skus: ['base', 'bad'], affected: ['base'] },
    { skus: ['000AbC,/ñ', 'base'], affected: ['000AbC,/ñ', 'base'] },
    {
      skus: ['bad', 'base', 'missing', '000AbC,/ñ', 'valid'],
      affected: ['base', '000AbC,/ñ'],
    },
    { skus: ['base', 'base', '000AbC,/ñ'], affected: ['base', '000AbC,/ñ'] },
  ])(
    'D-G2-02 reports all and only nonphysical bases: $skus',
    async ({ skus, affected }) => {
      const rows = [
        { ...row('base'), productHasVariants: true },
        { ...row('000AbC,/ñ'), productHasVariants: true },
        row('valid'),
        { ...row('bad'), weight: null },
      ];
      await expect(
        repositoryWith(rows).physicalData(skus),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'SKU_INVALIDO',
          details: { skusAfectados: affected },
        },
      });
    },
  );
  it.each([
    { weight: null },
    { weight: '0' },
    { weight: '-1' },
    { weight: 'NaN' },
    { weight: 'Infinity' },
    { length: null },
    { width: '0' },
    { height: '-2' },
    { profileUpdatedAt: null },
    { profileUpdatedAt: new Date('invalid') },
  ])('rejects incomplete/invalid profiles atomically: %j', async (invalid) => {
    const valid = row('valid'),
      bad = { ...row('000Bad'), ...invalid };
    await expect(
      repositoryWith([valid, bad, { ...bad, sku: 'other' }]).physicalData([
        'valid',
        '000Bad',
        'missing',
        'other',
      ]),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        code: 'DATOS_FISICOS_INCOMPLETOS',
        details: { skusAfectados: ['000Bad', 'other'] },
      },
    });
  });
  it.each(['ACTIVO', 'INACTIVO', 'BORRADOR', 'ACTIVA', 'INACTIVA'])(
    'reports incomplete existing state %s as 422',
    async (state) => {
      const sample = {
        ...row(),
        productStatus:
          state === 'ACTIVA' || state === 'INACTIVA' ? 'ACTIVO' : state,
        variantStatus: state,
        variantId:
          state.endsWith('A') && state !== 'BORRADOR' ? 'variant' : null,
        weight: null,
      };
      await expect(
        repositoryWith([sample]).physicalData([sample.sku]),
      ).rejects.toMatchObject({
        status: 422,
        response: { code: 'DATOS_FISICOS_INCOMPLETOS' },
      });
    },
  );
  it('classifies 100 opaque requested SKU exactly once with no extras', async () => {
    const skus = Array.from({ length: 100 }, (_, i) => '000,' + i);
    const result = await repositoryWith(
      skus.slice(0, 50).map((sku) => row(sku)),
    ).physicalData(skus);
    const classified = [
      ...result.productos.map((p) => p.sku),
      ...result.noEncontrados,
    ];
    expect(classified).toHaveLength(100);
    expect(new Set(classified)).toEqual(new Set(skus));
  });
  it('sanitizes query/transaction failures as 503', async () => {
    const database = {
      read: async () => {
        throw new Error('private SQL password');
      },
    } as unknown as Database;
    await expect(
      new CatalogQueryRepository(database).physicalData(['000']),
    ).rejects.toMatchObject({ status: 503 });
  });
});
