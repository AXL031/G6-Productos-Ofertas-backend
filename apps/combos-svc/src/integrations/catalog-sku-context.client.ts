export interface PricingCatalogContext {
  sku: string;
  productId: string;
  isVariant: boolean;
  active: boolean;
  eligible: boolean;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class IntegrationFailure extends Error {
  constructor(
    readonly dependency: 'CATALOG' | 'PRICING',
    readonly reason: string,
    readonly upstreamStatus?: number,
  ) {
    super(`${dependency}_${reason}`);
  }
}

export class CatalogSkuContextClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceBearer: () => string | undefined,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async getContext(
    sku: string,
    correlationId: string,
  ): Promise<PricingCatalogContext> {
    const bearer = this.serviceBearer();
    if (!bearer) throw new IntegrationFailure('CATALOG', 'AUTH_NOT_CONFIGURED');
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1/productos/skus/${encodeURIComponent(sku)}/contexto`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${bearer}`,
          'x-correlation-id': correlationId,
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new IntegrationFailure(
        'CATALOG',
        error instanceof Error && error.name === 'TimeoutError'
          ? 'TIMEOUT'
          : 'NETWORK_FAILURE',
      );
    }
    if (response.status === 404) {
      let problemCode: unknown;
      if (
        response.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() === 'application/problem+json'
      ) {
        try {
          const problem: unknown = await response.json();
          if (problem && typeof problem === 'object' && 'code' in problem)
            problemCode = problem.code;
        } catch {
          // A malformed 404 body is an upstream failure, never an absent SKU.
        }
      }
      if (problemCode === 'SKU_NO_ENCONTRADO')
        throw new IntegrationFailure('CATALOG', 'SKU_NO_ENCONTRADO', 404);
      throw new IntegrationFailure('CATALOG', 'UPSTREAM_FAILURE', 404);
    }
    if (response.status === 401)
      throw new IntegrationFailure(
        'CATALOG',
        'SERVICE_AUTHENTICATION_FAILED',
        401,
      );
    if (response.status === 403)
      throw new IntegrationFailure(
        'CATALOG',
        'SERVICE_AUTHORIZATION_FAILED',
        403,
      );
    if (response.status === 503)
      throw new IntegrationFailure('CATALOG', 'UNAVAILABLE', 503);
    if (!response.ok)
      throw new IntegrationFailure(
        'CATALOG',
        'UPSTREAM_FAILURE',
        response.status,
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new IntegrationFailure('CATALOG', 'INVALID_RESPONSE');
    }
    if (!value || typeof value !== 'object')
      throw new IntegrationFailure('CATALOG', 'INVALID_RESPONSE');
    const data = value as Record<string, unknown>;
    if (
      data.sku !== sku ||
      typeof data.productId !== 'string' ||
      !data.productId ||
      typeof data.isVariant !== 'boolean' ||
      typeof data.active !== 'boolean' ||
      typeof data.eligible !== 'boolean'
    )
      throw new IntegrationFailure('CATALOG', 'INVALID_RESPONSE');
    const context = data as unknown as PricingCatalogContext;
    if (!context.active)
      throw new IntegrationFailure('CATALOG', 'SKU_INACTIVO');
    if (!context.eligible)
      throw new IntegrationFailure('CATALOG', 'SKU_INELEGIBLE');
    return context;
  }
}
