import { randomUUID } from 'node:crypto';

export type InternalOperation =
  | 'obtenerProducto'
  | 'obtenerContextoSku'
  | 'obtenerPrecioSku'
  | 'consultarDisponibilidadComercial'
  | 'obtenerCategoriaAdmin';
export type Upstream = 'catalog' | 'pricing' | 'inventory' | 'taxonomy';
const operations: Record<
  InternalOperation,
  { service: Upstream; scope: string; missing: string }
> = {
  obtenerProducto: {
    service: 'catalog',
    scope: 'catalogo:leer',
    missing: 'PRODUCTO_NO_ENCONTRADO',
  },
  obtenerContextoSku: {
    service: 'catalog',
    scope: 'catalogo:leer',
    missing: 'SKU_NO_ENCONTRADO',
  },
  obtenerPrecioSku: {
    service: 'pricing',
    scope: 'precios:leer',
    missing: 'PRECIO_NO_ENCONTRADO',
  },
  consultarDisponibilidadComercial: {
    service: 'inventory',
    scope: 'inventario:disponibilidad:leer',
    missing: '',
  },
  obtenerCategoriaAdmin: {
    service: 'taxonomy',
    scope: 'catalogo:leer',
    missing: 'CATEGORIA_NO_ENCONTRADA',
  },
};
export type ServiceAccessTokenSource = (
  request: {
    operationId: InternalOperation;
    audience: 'api-productos';
    scope: string;
  },
  signal: AbortSignal,
) => Promise<string | null>;
export interface InternalHttpOptions {
  origin: string;
  origins?: Partial<Record<Upstream, string>>;
  mode?: 'AUTHENTICATED' | 'RESTRICTED_DEMO';
  getServiceAccessToken?: ServiceAccessTokenSource;
}

/** URL validation only; this does not verify DNS, routing or network isolation.
 * AUTHENTICATED sends a service bearer. Plain HTTP aliases are permitted solely
 * on the independently verified private g6-http network with trusted service DNS
 * and no public business ports; loopback is for same-host isolated processes.
 * Outside that boundary use HTTPS with certificate verification. See the PR143
 * transport/invalidation review for the release evidence required from infra.
 */
export function internalOrigin(
  value: string,
  demo: boolean,
  service?: Upstream,
): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const privateService = service && url.hostname === `${service}-svc`;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !['https:', 'http:'].includes(url.protocol) ||
    (demo
      ? !loopback && !privateService
      : url.protocol !== 'https:' && !loopback && !privateService)
  )
    throw new Error('INVALID_COMMERCIAL_ORIGIN');
  return url.origin;
}

// Bounded transport only: callers own their deadline and business DTO validation.
// Incoming user headers never enter this interface. Demo is explicit and restricted.
export class InternalHttpReader {
  private readonly origins: Partial<Record<Upstream, string>>;
  private readonly fallback: string;
  constructor(private readonly options: InternalHttpOptions) {
    const demo = options.mode === 'RESTRICTED_DEMO';
    // With explicit upstreams, origin is used only as a compatibility fallback.
    const firstService = (
      Object.keys(options.origins ?? {}) as Upstream[]
    ).find((service) => options.origins?.[service] === options.origin);
    this.fallback = internalOrigin(options.origin, demo, firstService);
    this.origins = Object.fromEntries(
      Object.entries(options.origins ?? {}).map(([service, origin]) => [
        service,
        internalOrigin(origin, demo, service as Upstream),
      ]),
    );
  }

  async read(
    operation: InternalOperation,
    path: string,
    signal: AbortSignal,
    missing = false,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const spec = operations[operation];
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Correlation-Id': randomUUID(),
    };
    if (this.options.mode !== 'RESTRICTED_DEMO') {
      // Own service credentials only. For HTTP aliases, the deployment must first
      // prove the private network above; an alias string alone proves no secrecy.
      const token = await this.options.getServiceAccessToken?.(
        {
          operationId: operation,
          audience: 'api-productos',
          scope: spec.scope,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!token || /\s/.test(token))
        throw new Error('COMMERCIAL_SESSION_UNAVAILABLE');
      headers.Authorization = 'Bearer ' + token;
    }
    const response = await fetch(
      (this.origins[spec.service] ?? this.fallback) + '/api/v1' + path,
      {
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers,
      },
    );
    if (
      !response.body ||
      !/^application\/(?:json|problem\+json)(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      await response.body?.cancel();
      throw new Error('COMMERCIAL_HTTP_UNAVAILABLE');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1_048_576) throw new Error('COMMERCIAL_RESPONSE_LIMIT');
        chunks.push(part.value);
      }
      const data: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        missing &&
        response.status === 404 &&
        typeof data === 'object' &&
        data !== null &&
        'status' in data &&
        data.status === 404 &&
        'code' in data &&
        data.code === spec.missing
      )
        return null;
      if (
        !response.ok ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw new Error('COMMERCIAL_HTTP_UNAVAILABLE');
      return data;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
