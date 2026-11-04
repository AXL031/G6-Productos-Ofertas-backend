import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type JsonWebKey,
} from 'node:crypto';
import {
  PromotionsIdentity,
  remotePromotionsKeys,
} from './promotions-identity.js';
import { httpContracts } from './http-contract.generated.js';
import { createEnvironmentFixture } from '../../test/support/environment.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../infrastructure/config/promotions-config.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk: JsonWebKey = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'isolated-key',
  alg: 'RS256',
  use: 'sig',
};
function token(
  changes: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    { alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...header },
    {
      iss: 'https://security.isolated.test/api/v1/auth',
      sub: 'modulo-marketplace',
      tipo: 'servicio',
      aud: ['api-productos'],
      scope: 'promociones:evaluar',
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
describe('Promotions signed identity', () => {
  const fixture = createEnvironmentFixture();
  const config = new PromotionsConfigService(
    validatePromotionsConfiguration({
      ...fixture.environment,
      AUTH_ISSUER: 'https://security.isolated.test/api/v1/auth',
      AUTH_JWKS_URL:
        'https://security.isolated.test/api/v1/auth/.well-known/jwks.json',
    }),
  );
  afterAll(() => fixture.cleanup());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const identity = () => new PromotionsIdentity(config, async () => [jwk]);
  it('verifies the actual signature, audience, service identity and exact scope', async () => {
    await expect(
      identity().authorize(
        httpContracts.evaluarPromociones,
        'Bearer ' + token(),
      ),
    ).resolves.toBeUndefined();
  });
  it('accepts a human Gestor Comercial without inventing a user audience or scope', async () => {
    await expect(
      identity().authorize(
        httpContracts.listarCupones,
        'Bearer ' +
          token({
            sub: randomUUID(),
            tipo: 'acceso',
            aud: undefined,
            scope: undefined,
            roles: ['GESTOR_COMERCIAL'],
          }),
      ),
    ).resolves.toBeUndefined();
  });
  it.each([
    { exp: 0 },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
    { iss: 'https://wrong.test' },
    { iat: undefined },
    { jti: '' },
    { tipo: 'refresco' },
  ])('rejects invalid signed claims %j', async (changes) => {
    await expect(
      identity().authorize(
        httpContracts.evaluarPromociones,
        'Bearer ' + token(changes),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });
  });
  it.each([
    { alg: 'none' },
    { alg: 'HS256' },
    { kid: 'unknown' },
    { crit: ['untrusted'] },
    { typ: 'other' },
  ])('rejects unsupported headers %j', async (header) => {
    await expect(
      identity().authorize(
        httpContracts.evaluarPromociones,
        'Bearer ' + token({}, header),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a modified signature and malformed/missing tokens', async () => {
    const raw = token();
    const parts = raw.split('.');
    const signature = Buffer.from(parts[2], 'base64url');
    signature[0] ^= 1;
    for (const authorization of [
      undefined,
      'Bearer broken',
      'Basic abc',
      'Bearer ' +
        parts.slice(0, 2).join('.') +
        '.' +
        signature.toString('base64url'),
    ])
      await expect(
        identity().authorize(httpContracts.evaluarPromociones, authorization),
      ).rejects.toMatchObject({ status: 401 });
  });
  it('distinguishes wrong audience (401), missing scope (403) and disallowed client (403)', async () => {
    for (const [claims, status] of [
      [{ aud: ['api-other'] }, 401],
      [{ scope: 'promociones:leer' }, 403],
      [{ sub: 'modulo-ventas' }, 403],
    ] as const)
      await expect(
        identity().authorize(
          httpContracts.evaluarPromociones,
          'Bearer ' + token(claims),
        ),
      ).rejects.toMatchObject({ status });
    await expect(
      identity().authorize(httpContracts.listarCupones, 'Bearer ' + token()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('never derives the human role from permisos or a technical identity', async () => {
    await expect(
      identity().authorize(
        httpContracts.listarCupones,
        'Bearer ' +
          token({
            tipo: 'acceso',
            sub: randomUUID(),
            roles: [],
            permisos: ['GESTOR_COMERCIAL'],
          }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed with no issuer/JWKS configuration', async () => {
    const missing = new PromotionsIdentity(
      new PromotionsConfigService(
        validatePromotionsConfiguration(fixture.environment),
      ),
      async () => [jwk],
    );
    await expect(
      missing.authorize(httpContracts.evaluarPromociones, 'Bearer ' + token()),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('retains a known cached key across a JWKS outage and fails closed for unknown keys', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const remote = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })))
      .mockRejectedValue(new Error('secret diagnostic'));
    vi.stubGlobal('fetch', remote);
    const keys = remotePromotionsKeys(config);
    expect(await keys('isolated-key')).toEqual([jwk]);
    now += 61000;
    const [unknown, known] = await Promise.allSettled([
      keys('unknown-key'),
      keys('isolated-key'),
    ]);
    expect(known).toEqual({ status: 'fulfilled', value: [jwk] });
    expect(unknown).toMatchObject({
      status: 'rejected',
      reason: { status: 503, code: 'SERVICIO_NO_DISPONIBLE' },
    });
    expect(remote).toHaveBeenCalledTimes(2);
    expect(remote.mock.calls[0][0]).toBe(config.settings.auth!.jwksUrl);
    expect(remote.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
  it('bounds the JWKS response and never accepts a private or duplicated key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(65537))),
    );
    await expect(
      remotePromotionsKeys(config)('isolated-key'),
    ).rejects.toMatchObject({ status: 503 });
    for (const keys of [[jwk, jwk], [{ ...jwk, d: 'private' }]])
      await expect(
        new PromotionsIdentity(config, async () => keys).authorize(
          httpContracts.evaluarPromociones,
          'Bearer ' + token(),
        ),
      ).rejects.toMatchObject({ status: 401 });
  });
});
