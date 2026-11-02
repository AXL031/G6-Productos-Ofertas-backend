import { readCatalogServiceCredentials } from './catalog-service-credentials.js';
describe('Catalog own G7 service credentials configuration', () => {
  const issuer = 'https://security.example/api/v1/auth';
  const good = {
    CATALOG_SERVICE_TOKEN_URL: issuer + '/token',
    CATALOG_SERVICE_CLIENT_SECRET: 'private-fixture',
  };
  it('is disabled without configuration and preserves the secret verbatim', () => {
    expect(readCatalogServiceCredentials({})).toBeUndefined();
    expect(readCatalogServiceCredentials(good, issuer)).toEqual({
      tokenUrl: issuer + '/token',
      clientSecret: 'private-fixture',
    });
  });
  it.each([
    { CATALOG_SERVICE_CLIENT_SECRET: 'private-fixture' },
    { CATALOG_SERVICE_TOKEN_URL: issuer + '/token' },
    {
      ...good,
      CATALOG_SERVICE_TOKEN_URL: 'https://other.example/api/v1/auth/token',
    },
    { ...good, CATALOG_SERVICE_TOKEN_URL: 'https://security.example/other' },
    {
      ...good,
      CATALOG_SERVICE_TOKEN_URL:
        'https://user:pass@security.example/api/v1/auth/token',
    },
    { ...good, CATALOG_SERVICE_TOKEN_URL: issuer + '/token?query=1' },
    { ...good, CATALOG_SERVICE_CLIENT_SECRET: '' },
  ])(
    'rejects unsafe/incomplete credentials without disclosing values %j',
    (env) => {
      expect(() => readCatalogServiceCredentials(env, issuer)).toThrow(
        'CATALOG_SERVICE_TOKEN_URL',
      );
      try {
        readCatalogServiceCredentials(env, issuer);
      } catch (error) {
        expect(String(error)).not.toContain('private-fixture');
      }
    },
  );
});
