import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createEnvironmentFixture } from '../../../test/support/environment.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../config/promotions-config.js';
import { PromotionsIdentity } from '../../http/promotions-identity.js';
import { promotionsServiceTokens } from './service-tokens.js';

const issuer = 'https://g7.isolated.test/api/v1/auth';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'isolated',
  alg: 'RS256',
  use: 'sig',
};
function token(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    { alg: 'RS256', kid: key.kid },
    {
      iss: issuer,
      sub: 'modulo-productos',
      tipo: 'servicio',
      aud: ['api-productos'],
      scope: 'catalogo:leer',
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
      ...changes,
    },
  ].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'));
  return (
    parts.join('.') +
    '.' +
    sign('RSA-SHA256', Buffer.from(parts.join('.')), pair.privateKey).toString(
      'base64url',
    )
  );
}
const request = {
  operationId: 'obtenerContextoSku',
  audience: 'api-productos',
  scope: 'catalogo:leer',
} as const;
const response = (
  accessToken = token(),
  overrides: Record<string, unknown> = {},
) =>
  Response.json({
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 600,
    scopes: ['catalogo:leer'],
    ...overrides,
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Promotions own G7 client_credentials (explicit contract fixture)', () => {
  const fixture = createEnvironmentFixture();
  const config = (overrides: NodeJS.ProcessEnv = {}) =>
    new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        AUTH_ISSUER: issuer,
        AUTH_JWKS_URL: issuer + '/.well-known/jwks.json',
        PROMOTIONS_SERVICE_TOKEN_URL: issuer + '/token',
        PROMOTIONS_SERVICE_CLIENT_SECRET: 'synthetic-own-secret',
        ...overrides,
      }),
    );
  const source = (settings = config()) =>
    promotionsServiceTokens(
      settings,
      new PromotionsIdentity(settings, async () => [key]),
    );
  const signal = () => new AbortController().signal;
  afterAll(() => fixture.cleanup());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests only the operation scope, verifies RS256, and reuses its own unexpired token', async () => {
    const jwt = token();
    const fetcher = vi.fn(async () => response(jwt));
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    expect(await tokens(request, signal())).toBe(jwt);
    expect(await tokens(request, signal())).toBe(jwt);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = (
      fetcher.mock.calls as unknown as [string, RequestInit][]
    )[0];
    expect(url).toBe(issuer + '/token');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(
      Object.fromEntries(new URLSearchParams(String(options.body))),
    ).toEqual({
      grant_type: 'client_credentials',
      client_id: 'modulo-productos',
      client_secret: 'synthetic-own-secret',
      scope: 'catalogo:leer',
    });
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  it('keeps the price and catalogue grants separate', async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const scope = new URLSearchParams(String(options.body)).get('scope')!;
      return response(token({ scope }), { scopes: [scope] });
    });
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    await tokens(request, signal());
    await tokens(
      { ...request, operationId: 'obtenerPrecioSku', scope: 'precios:leer' },
      signal(),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('renews before the earlier of JWT expiry and expiresIn', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn(async () => response(token(), { expiresIn: 10 }));
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    await tokens(request, signal());
    now += 9500;
    await tokens(request, signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { sub: 'modulo-marketplace' },
    { tipo: 'acceso', roles: ['GESTOR_COMERCIAL'] },
    { iss: 'https://wrong.test' },
    { aud: ['wrong'] },
    { scope: 'precios:leer' },
    { exp: 1 },
    { iat: 9999999999 },
  ])('rejects a signed but unauthorized G7 response: %j', async (claims) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(token(claims))),
    );
    await expect(source()(request, signal())).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
  });

  it('rejects tampered signatures', async () => {
    const parts = token().split('.');
    parts[2] = Buffer.alloc(256).toString('base64url');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(parts.join('.'))),
    );
    await expect(source()(request, signal())).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
  });

  it.each([
    { tokenType: 'bearer' },
    { expiresIn: 0 },
    { expiresIn: 1.5 },
    { scopes: [] },
    { scopes: ['catalogo:leer', 'precios:leer'] },
    { accessToken: 'not-a-jwt' },
  ])('rejects an invalid token envelope: %j', async (overrides) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(token(), overrides)),
    );
    await expect(source()(request, signal())).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
  });

  it('fails closed without credentials and makes no token request in restricted demo', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(
      await source(
        config({
          PROMOTIONS_SERVICE_TOKEN_URL: undefined,
          PROMOTIONS_SERVICE_CLIENT_SECRET: undefined,
        }),
      )(request, signal()),
    ).toBeNull();
    expect(
      await source(config({ GATEWAY_DEMO_NO_AUTH_ENABLED: 'true' }))(
        request,
        signal(),
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not cache a rejected grant or expose G7 diagnostics', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('synthetic-own-secret', { status: 401 }),
      )
      .mockImplementationOnce(async () => response());
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    await expect(tokens(request, signal())).rejects.toThrow(
      /^PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE$/,
    );
    await expect(tokens(request, signal())).resolves.toEqual(
      expect.any(String),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects non-JSON and oversized responses', async () => {
    for (const value of [
      new Response('private diagnostic'),
      Response.json({ accessToken: 'x'.repeat(65536) }),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => value),
      );
      await expect(source()(request, signal())).rejects.toThrow(
        'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
      );
    }
  });

  it('cancels the transport when its only waiter aborts and rejects an aborted cache hit', async () => {
    const controller = new AbortController();
    let transport: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        transport = options.signal;
        return new Promise<Response>(() => {});
      }),
    );
    const pending = source()(request, controller.signal);
    const rejected = expect(pending).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
    await vi.waitFor(() => expect(transport).toBeDefined());
    controller.abort();
    await rejected;
    expect(transport?.aborted).toBe(true);
    const tokens = source();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
    await tokens(request, signal());
    await expect(tokens(request, controller.signal)).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
  });

  it('shares one in-flight issuance for concurrent operations with the same scope', async () => {
    const issued = deferred<Response>();
    const fetcher = vi.fn(() => issued.promise);
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    const calls = Array.from({ length: 8 }, (_, i) =>
      tokens(
        {
          ...request,
          operationId: i % 2 ? 'obtenerProducto' : 'obtenerContextoSku',
        },
        signal(),
      ),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const jwt = token();
    issued.resolve(response(jwt));
    expect(await Promise.all(calls)).toEqual(Array(8).fill(jwt));
  });

  it('issues different scopes independently while each scope has concurrent waiters', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Response>>>();
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      const scope = new URLSearchParams(String(options.body)).get('scope')!;
      const issued = deferred<Response>();
      pending.set(scope, issued);
      return issued.promise;
    });
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    const price = {
      ...request,
      operationId: 'obtenerPrecioSku',
      scope: 'precios:leer',
    } as const;
    const calls = [
      tokens(request, signal()),
      tokens(request, signal()),
      tokens(price, signal()),
      tokens(price, signal()),
    ];
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    for (const [scope, issued] of pending)
      issued.resolve(response(token({ scope }), { scopes: [scope] }));
    await Promise.all(calls);
  });

  it('cancels one waiter promptly without cancelling another waiter or its transport', async () => {
    const issued = deferred<Response>();
    let transport: AbortSignal | null | undefined;
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      transport = options.signal;
      return issued.promise;
    });
    vi.stubGlobal('fetch', fetcher);
    const tokens = source(),
      first = new AbortController();
    const a = tokens(request, first.signal),
      b = tokens(request, signal());
    const rejected = expect(a).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    first.abort();
    await rejected;
    expect(transport?.aborted).toBe(false);
    const jwt = token();
    issued.resolve(response(jwt));
    expect(await b).toBe(jwt);
    expect(await tokens(request, signal())).toBe(jwt);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries immediately after all waiters abort and ignores late abandoned work', async () => {
    const old = deferred<Response>(),
      fresh = deferred<Response>();
    const transports: (AbortSignal | null | undefined)[] = [];
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      transports.push(options.signal);
      return transports.length === 1 ? old.promise : fresh.promise;
    });
    vi.stubGlobal('fetch', fetcher);
    const tokens = source(),
      a = new AbortController(),
      b = new AbortController();
    const first = tokens(request, a.signal),
      second = tokens(request, b.signal);
    const failures = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    a.abort();
    b.abort();
    expect((await failures).every((v) => v.status === 'rejected')).toBe(true);
    expect(transports[0]?.aborted).toBe(true);
    const retry = tokens(request, signal());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    old.resolve(response(token()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const join = tokens(request, signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const jwt = token();
    fresh.resolve(response(jwt));
    expect(await Promise.all([retry, join])).toEqual([jwt, jwt]);
    expect(await tokens(request, signal())).toBe(jwt);
  });

  it('releases failed shared requests so a later call can recover', async () => {
    const failed = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(async () => response());
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    const results = Promise.allSettled([
      tokens(request, signal()),
      tokens(request, signal()),
    ]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    failed.resolve(new Response('private diagnostic', { status: 401 }));
    for (const result of await results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(result.reason.message).toBe(
          'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
        );
    }
    await expect(tokens(request, signal())).resolves.toEqual(
      expect.any(String),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('captures the validated operation scope before asynchronous issuance', async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(new URLSearchParams(String(options.body)).get('scope')).toBe(
        'catalogo:leer',
      );
      return response();
    });
    vi.stubGlobal('fetch', fetcher);
    const tokens = source();
    const mutable = { ...request, scope: 'catalogo:leer' };
    const result = tokens(mutable, signal());
    mutable.scope = 'precios:leer';
    const issued = await result;
    expect(await tokens(request, signal())).toBe(issued);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { operationId: 'obtenerProducto', scope: 'precios:leer' },
    {
      operationId: 'obtenerContextoSku',
      scope: 'inventario:disponibilidad:leer',
    },
    { operationId: 'obtenerPrecioSku', scope: 'catalogo:leer' },
    { operationId: 'consultarDisponibilidadComercial', scope: 'precios:leer' },
    { operationId: 'obtenerCategoriaAdmin', scope: 'precios:leer' },
  ] as const)(
    'rejects a permitted scope assigned to the wrong operation: %j',
    async (invalid) => {
      const fetcher = vi.fn(async () => response());
      vi.stubGlobal('fetch', fetcher);
      const tokens = source();
      // Warm the catalogue cache: validation must also precede cache reuse.
      await tokens(request, signal());
      await expect(
        tokens({ ...request, ...invalid }, signal()),
      ).rejects.toThrow('PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds a stalled issuer request and aborts its transport', async () => {
    let transportSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        transportSignal = options.signal;
        return new Promise<Response>(() => {});
      }),
    );
    const tokens = source();
    const results = await Promise.allSettled([
      tokens(request, signal()),
      tokens(request, signal()),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(transportSignal?.aborted).toBe(true);
    const recovered = token();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(recovered)),
    );
    expect(await tokens(request, signal())).toBe(recovered);
  });
});
