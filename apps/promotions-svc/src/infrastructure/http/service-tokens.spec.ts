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

  it('propagates cancellation to the token request and never uses an aborted cache hit', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        controller.abort();
        expect(options.signal?.aborted).toBe(true);
        throw new Error('private diagnostic');
      }),
    );
    await expect(source()(request, controller.signal)).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
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

  it('bounds a stalled issuer request and aborts its transport', async () => {
    let transportSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        transportSignal = options.signal;
        return new Promise<Response>(() => {});
      }),
    );
    await expect(source()(request, signal())).rejects.toThrow(
      'PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE',
    );
    expect(transportSignal?.aborted).toBe(true);
  });
});
