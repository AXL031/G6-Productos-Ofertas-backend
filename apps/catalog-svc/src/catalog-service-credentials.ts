export interface CatalogServiceCredentials {
  tokenUrl: string;
  clientSecret: string;
}
/** Published G7 emitirTokenServicio; no credentials or issuer fallback. */
export function readCatalogServiceCredentials(
  env: Record<string, string | undefined>,
  issuer?: string,
) {
  const tokenUrl = env.CATALOG_SERVICE_TOKEN_URL,
    clientSecret = env.CATALOG_SERVICE_CLIENT_SECRET;
  if (tokenUrl === undefined && clientSecret === undefined) return undefined;
  try {
    if (!tokenUrl || !clientSecret?.trim() || !issuer) throw new Error();
    const url = new URL(tokenUrl),
      origin = new URL(issuer);
    if (
      url.origin !== origin.origin ||
      url.pathname !== '/api/v1/auth/token' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error();
    return Object.freeze({ tokenUrl: url.href, clientSecret });
  } catch {
    throw new Error(
      'CATALOG_SERVICE_TOKEN_URL y CATALOG_SERVICE_CLIENT_SECRET deben configurarse juntos con el emisor autorizado.',
    );
  }
}
