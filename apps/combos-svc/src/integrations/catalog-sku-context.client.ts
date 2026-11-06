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
export type BearerProvider = (
  signal?: AbortSignal,
) => string | undefined | Promise<string | undefined>;

export class IntegrationFailure extends Error {
  constructor(
    readonly dependency: 'CATALOG' | 'PRICING',
    readonly reason: string,
    readonly upstreamStatus?: number,
  ) {
    super(`${dependency}_${reason}`);
  }
}

async function boundedJson(
  response: Response,
  allowProblem = false,
): Promise<unknown> {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType !== 'application/json' &&
    !(allowProblem && contentType === 'application/problem+json')
  )
    throw new Error('INVALID_CONTENT_TYPE');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('BODY_REQUIRED');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('BODY_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export class CatalogSkuContextClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceBearer: BearerProvider,
    private readonly fetcher: FetchLike = fetch,
    private readonly invalidateBearer?: () => void,
    private readonly totalDeadlineMs = 10000,
  ) {}

  async getContext(
    sku: string,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<PricingCatalogContext> {
    const context = await this.fetchContext(sku, correlationId, signal);
    if (!context.active)
      throw new IntegrationFailure('CATALOG', 'SKU_INACTIVO');
    if (!context.eligible)
      throw new IntegrationFailure('CATALOG', 'SKU_INELEGIBLE');
    return context;
  }

  async getContextForMapping(
    sku: string,
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<PricingCatalogContext> {
    return this.fetchContext(sku, correlationId, signal);
  }

  private async fetchContext(
    sku: string,
    correlationId: string,
    operationSignal?: AbortSignal,
  ): Promise<PricingCatalogContext> {
    const deadline = AbortSignal.timeout(this.totalDeadlineMs);
    const requestSignal = operationSignal
      ? AbortSignal.any([deadline, operationSignal])
      : deadline;
    let bearer = await this.serviceBearer(requestSignal);
    if (!bearer) throw new IntegrationFailure('CATALOG', 'AUTH_NOT_CONFIGURED');
    const url = new URL(
      `/api/v1/productos/skus/${encodeURIComponent(sku)}/contexto`,
      this.baseUrl,
    );
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (this.fetcher === fetch &&
        url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        !url.hostname.endsWith('-svc') &&
        !url.hostname.endsWith('.svc'))
    )
      throw new IntegrationFailure('CATALOG', 'INVALID_CONFIGURATION');
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await this.fetcher(url, {
          redirect: 'error',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${bearer}`,
            'x-correlation-id': correlationId,
          },
          signal: AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]),
        });
      } catch (error) {
        throw new IntegrationFailure(
          'CATALOG',
          error instanceof Error &&
            (error.name === 'TimeoutError' || error.name === 'AbortError')
            ? 'TIMEOUT'
            : 'NETWORK_FAILURE',
        );
      }
      if (response.status !== 401 || attempt > 0 || !this.invalidateBearer)
        break;
      await response.body?.cancel();
      this.invalidateBearer();
      bearer = await this.serviceBearer(requestSignal);
      if (!bearer)
        throw new IntegrationFailure('CATALOG', 'AUTH_NOT_CONFIGURED');
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
          const problem: unknown = await boundedJson(response, true);
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
    if (response.status === 401) await response.body?.cancel();
    if (response.status === 401)
      throw new IntegrationFailure(
        'CATALOG',
        'SERVICE_AUTHENTICATION_FAILED',
        401,
      );
    if (response.status === 403) await response.body?.cancel();
    if (response.status === 403)
      throw new IntegrationFailure(
        'CATALOG',
        'SERVICE_AUTHORIZATION_FAILED',
        403,
      );
    if (response.status === 503) await response.body?.cancel();
    if (response.status === 503)
      throw new IntegrationFailure('CATALOG', 'UNAVAILABLE', 503);
    if (response.status !== 200) await response.body?.cancel();
    if (response.status !== 200)
      throw new IntegrationFailure(
        'CATALOG',
        'UPSTREAM_FAILURE',
        response.status,
      );
    let value: unknown;
    try {
      value = await boundedJson(response);
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
    return data as unknown as PricingCatalogContext;
  }
}
