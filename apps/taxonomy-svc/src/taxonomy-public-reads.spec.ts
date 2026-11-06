import {
  readTaxonomyPublicReadConfig,
  readTaxonomyDemoConfig,
  readTaxonomySecurityConfig,
} from './taxonomy-auth.js';

describe('Taxonomy public-read configuration boundary', () => {
  it('rejects a simulated issuer configured as the G7 issuer', () => {
    expect(() =>
      readTaxonomySecurityConfig({
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: 'https://g7.test/auth',
        SIMULATED_AUTH_JWKS_URL: 'https://simulator.test/keys',
        SECURITY_ISSUER: 'https://g7.test/auth',
      }),
    ).toThrow(/independiente/);
  });
  it('admits exact academic read IDs but rejects unknown names and writes', () => {
    for (const operation of [
      'obtenerMarca',
      'obtenerCategoria',
      'obtenerArbolCategorias',
      'crearCategoria',
      'actualizarMarca',
    ])
      expect(() =>
        readTaxonomyPublicReadConfig({
          G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
          TAXONOMY_PUBLIC_OPERATION_IDS: operation,
        }),
      ).toThrow();
    expect(
      readTaxonomyPublicReadConfig({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        TAXONOMY_PUBLIC_OPERATION_IDS:
          'obtenerMarcaAdmin,listarMarcasAdmin,listarTiposProducto,obtenerCaracteristica',
      }).publicOperations,
    ).toHaveLength(4);
    expect(
      readTaxonomyPublicReadConfig({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        TAXONOMY_PUBLIC_OPERATION_IDS: 'listarCategorias,listarMarcas',
      }).publicOperations,
    ).toHaveLength(2);
  });
  it('accepts simulated auth but rejects legacy bypasses with an explicit selector', () => {
    expect(
      readTaxonomyPublicReadConfig({ G6_SECURITY_MODE: 'SIMULATED_AUTH' }),
    ).toMatchObject({ securityMode: 'SIMULATED_AUTH' });
    for (const mode of ['PUBLIC_READ_ONLY', 'G7_AUTHENTICATED'])
      expect(() =>
        readTaxonomyDemoConfig({
          NODE_ENV: 'test',
          G6_SECURITY_MODE: mode,
          ALLOW_DEMO_UNAUTHENTICATED: 'true',
        }),
      ).toThrow();
    expect(
      readTaxonomyPublicReadConfig({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        G6_PUBLIC_OPERATION_IDS: 'listarCategorias',
      }).publicOperations,
    ).toEqual([]);
  });
});
