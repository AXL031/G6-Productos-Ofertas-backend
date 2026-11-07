import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { BulkUserBearerGuard } from './bulk-user-bearer.guard.js';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';

// Cryptographic contract fixtures, not real G7 token/grant certification.
describe('bulk-svc: phase 3 trust lifecycle', () => {
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
    const identity = new BulkUserBearerGuard();
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
