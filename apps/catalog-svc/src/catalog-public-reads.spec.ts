import { readCatalogReadDemo } from './catalog-read-demo.js';
import { readCatalogSecurityConfig } from './catalog-auth.js';

describe('Public-read authorization never selects Catalog demo data', () => {
  it('rejects a simulated issuer configured as the G7 issuer', () => {
    expect(() =>
      readCatalogSecurityConfig({
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: 'https://g7.test/auth',
        SIMULATED_AUTH_JWKS_URL: 'https://simulator.test/keys',
        SECURITY_ISSUER: 'https://g7.test/auth',
      }),
    ).toThrow(/independiente/);
  });
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
  it('rejects legacy mixing and writes while accepting explicitly selected academic reads', () => {
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
      'crearProducto',
      'activarProducto',
      'operacionInventada',
    ])
      expect(() =>
        readCatalogReadDemo({
          G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
          CATALOG_PUBLIC_OPERATION_IDS: operation,
        }),
      ).toThrow();
    expect(
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        CATALOG_PUBLIC_OPERATION_IDS:
          'obtenerPreparacionProducto,obtenerContextoSku',
      }).publicOperations,
    ).toEqual(['obtenerPreparacionProducto', 'obtenerContextoSku']);
    expect(
      readCatalogReadDemo({ G6_SECURITY_MODE: 'SIMULATED_AUTH' }),
    ).toMatchObject({ enabled: false, securityMode: 'SIMULATED_AUTH' });
    expect(
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        G6_PUBLIC_OPERATION_IDS: 'listarProductos',
      }).publicOperations,
    ).toEqual([]);
  });
});
