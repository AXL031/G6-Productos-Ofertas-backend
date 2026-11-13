import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { UserAuthGuard } from './user-auth.guard.js';
import { InventoryAuthGuard } from './inventory-auth.guard.js';
import {
  REQUIRED_SCOPE_KEY,
  ALLOWED_CLIENTS_KEY,
  REQUIRED_CAPABILITY_KEY,
} from './auth.constants.js';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';

// Cryptographic contract fixtures, not real G7 token/grant certification.
describe('inventory-svc: phase 3 trust lifecycle', () => {
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://g7.contract.test/api/v1/auth';
  const jwk = (pair: typeof first, kid: string) => ({
    ...pair.publicKey.export({ format: 'jwk' }),
    kid,
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
  });
  let verify: (token: string) => Promise<unknown>;
  let keys: object[];
  let offline = false;
  let jwksUrl = '';
  const token = (
    pair = first,
    kid = 'first',
    overrides: Record<string, unknown> = {},
  ) => {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const input =
      encode({ alg: 'RS256', typ: 'JWT', kid }) +
      '.' +
      encode({
        iss: issuer,
        sub: '11111111-1111-4111-8111-111111111111',
        tipo: 'acceso',
        email: 'test@example.invalid',
        roles: ['GESTOR_COMERCIAL'],
        permisos: [],
        iat: now,
        exp: now + 900,
        jti: randomUUID(),
        ...overrides,
      });
    return (
      input +
      '.' +
      sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString(
        'base64url',
      )
    );
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
    jwksUrl = issuer + '/jwks/' + randomUUID();
    keys = [jwk(first, 'first')];
    offline = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (offline) throw new Error('isolated provider unavailable');
        const body = String(url).endsWith('/openid')
          ? { issuer, jwks_uri: jwksUrl }
          : { keys };
        return new Response(JSON.stringify(body), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=3600',
          },
        });
      }),
    );
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('G7_JWT_ISSUER', issuer);
    vi.stubEnv('G7_JWT_JWKS_URL', jwksUrl);
    const identity = new UserAuthGuard(new Reflector());
    verify = async (token) => {
      const ctx = new ExecutionContextHost(
        [
          {
            headers: { authorization: 'Bearer ' + token },
            method: 'GET',
            path: '/not-public',
          },
        ],
        class Protected {},
        function protectedRead() {},
      );
      return identity.canActivate(ctx);
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('accepts the human G7 profile without inventing aud and rejects other issuers or altered signatures', async () => {
    await expect(verify(token())).resolves.toBeDefined();
    await expect(
      verify(
        token(first, 'first', { iss: 'https://simulated.invalid/issuer' }),
      ),
    ).rejects.toThrow();
    const parts = token().split('.');
    parts[2] = 'AAAA';
    await expect(verify(parts.join('.'))).rejects.toThrow();
  });
  it('refreshes a rotated kid and retains only previously trusted keys within the bounded outage window', async () => {
    await expect(verify(token())).resolves.toBeDefined();
    keys = [jwk(first, 'first'), jwk(rotated, 'rotated')];
    await expect(verify(token(rotated, 'rotated'))).resolves.toBeDefined();
    offline = true;
    vi.setSystemTime(Date.now() + 61000);
    await expect(verify(token())).resolves.toBeDefined();
    await expect(verify(token(rotated, 'rotated'))).resolves.toBeDefined();
    await expect(verify(token(rotated, 'never-trusted'))).rejects.toThrow();
    vi.setSystemTime(Date.now() + 3601000);
    await expect(verify(token())).rejects.toThrow();
  });
  it('uses signed sub for M2M and rejects an overriding client_id', async () => {
    function serviceRead() {}
    Reflect.defineMetadata(
      REQUIRED_SCOPE_KEY,
      'inventario:disponibilidad:leer',
      serviceRead,
    );
    Reflect.defineMetadata(ALLOWED_CLIENTS_KEY, ['modulo-ventas'], serviceRead);
    const identity = new InventoryAuthGuard(new Reflector());
    const authorize = (extra: Record<string, unknown> = {}) =>
      identity.canActivate(
        new ExecutionContextHost(
          [
            {
              headers: {
                authorization:
                  'Bearer ' +
                  token(first, 'first', {
                    tipo: 'servicio',
                    sub: 'modulo-ventas',
                    aud: ['api-productos'],
                    scope: 'inventario:disponibilidad:leer',
                    ...extra,
                  }),
              },
              method: 'GET',
              path: '/not-public',
            },
          ],
          class Protected {},
          serviceRead,
        ),
      );
    await expect(authorize()).resolves.toBe(true);
    await expect(
      authorize({ client_id: 'modulo-retail' }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('authorizes transfers only from an explicit local grant for the verified G7 sub', async () => {
    function transferRead() {}
    Reflect.defineMetadata(
      REQUIRED_CAPABILITY_KEY,
      'INVENTARIO_TRASLADOS_LEER',
      transferRead,
    );
    const ctx = new ExecutionContextHost(
      [
        {
          headers: {
            authorization:
              'Bearer ' +
              token(first, 'first', {
                capabilities: ['INVENTARIO_TRASLADOS_LEER'],
              }),
          },
          method: 'GET',
          path: '/not-public',
        },
      ],
      class Protected {},
      transferRead,
    );
    vi.stubEnv('INVENTORY_G7_TRANSFER_GRANTS', '');
    const guard = new UserAuthGuard(new Reflector());
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 403 });
    const subject = '44444444-4444-4444-8444-444444444444';
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: { authorization: string } }>();
    req.headers.authorization =
      'Bearer ' + token(first, 'first', { sub: subject });
    vi.stubEnv(
      'INVENTORY_G7_TRANSFER_GRANTS',
      JSON.stringify({ [subject]: ['INVENTARIO_TRASLADOS_LEER'] }),
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    vi.stubEnv(
      'INVENTORY_G7_TRANSFER_GRANTS',
      '{"invalid":["INVENTARIO_TRASLADOS_LEER"]}',
    );
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 503 });
  });
  it('requires temporal claims and jti from the G7 profile', async () => {
    for (const extra of [
      { iat: undefined },
      { jti: undefined },
      { exp: undefined },
      { iat: Math.floor(Date.now() / 1000) + 10 },
    ])
      await expect(verify(token(first, 'first', extra))).rejects.toThrow();
  });
  it('does not retain a retired key after a successful refresh', async () => {
    await expect(verify(token())).resolves.toBeDefined();
    keys = [jwk(rotated, 'rotated')];
    vi.setSystemTime(Date.now() + 61000);
    await expect(verify(token(rotated, 'rotated'))).resolves.toBeDefined();
    await expect(verify(token())).rejects.toThrow();
  });
});
