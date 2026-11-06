import { readCatalogReadDemo } from './catalog-read-demo.js';

describe('Public-read authorization never selects Catalog demo data', () => {
  it('keeps legacy data expansion disabled even when all three public candidates are enabled', () => {
    expect(
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        G6_READ_ONLY_DEMO_ENABLED: 'false',
        CATALOG_PUBLIC_OPERATION_IDS:
          'listarProductos,obtenerProducto,obtenerProductoPorSlug',
      }),
    ).toMatchObject({
      enabled: false,
      securityMode: 'PUBLIC_READ_ONLY',
      publicOperations: [
        'listarProductos',
        'obtenerProducto',
        'obtenerProductoPorSlug',
      ],
    });
  });
  it('rejects legacy/public mixing, noncommercial operations and unapproved simulated auth', () => {
    for (const flag of [
      'G6_READ_ONLY_DEMO_ENABLED',
      'GATEWAY_DEMO_NO_AUTH_ENABLED',
      'CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED',
    ])
      expect(() =>
        readCatalogReadDemo({
          G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
          [flag]: 'true',
        }),
      ).toThrow();
    for (const operation of [
      'obtenerPreparacionProducto',
      'obtenerContextoSku',
      'crearProducto',
    ])
      expect(() =>
        readCatalogReadDemo({
          G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
          CATALOG_PUBLIC_OPERATION_IDS: operation,
        }),
      ).toThrow();
    expect(() =>
      readCatalogReadDemo({ G6_SECURITY_MODE: 'SIMULATED_AUTH' }),
    ).toThrow();
    expect(
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        G6_PUBLIC_OPERATION_IDS: 'listarProductos',
      }).publicOperations,
    ).toEqual([]);
  });
});
