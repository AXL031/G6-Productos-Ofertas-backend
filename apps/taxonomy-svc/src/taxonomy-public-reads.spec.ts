import {
  readTaxonomyPublicReadConfig,
  readTaxonomyDemoConfig,
} from './taxonomy-auth.js';

describe('Taxonomy public-read configuration boundary', () => {
  it('only admits the two commercial lists; administrative/internal candidates fail at startup', () => {
    for (const operation of [
      'obtenerMarca',
      'obtenerMarcaAdmin',
      'obtenerCategoria',
      'listarMarcasAdmin',
      'obtenerArbolCategorias',
      'listarTiposProducto',
      'obtenerCaracteristica',
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
        TAXONOMY_PUBLIC_OPERATION_IDS: 'listarCategorias,listarMarcas',
      }).publicOperations,
    ).toHaveLength(2);
  });
  it('rejects simulated auth and legacy bypasses with an explicit selector', () => {
    expect(() =>
      readTaxonomyPublicReadConfig({ G6_SECURITY_MODE: 'SIMULATED_AUTH' }),
    ).toThrow();
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
