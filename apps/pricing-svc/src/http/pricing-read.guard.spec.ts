import { PricingReadGuard } from './pricing-read.guard.js';
import { SignedUser } from '../../test/signed-user.js';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { validateEnvironment } from '../config/environment.js';

describe('Pricing: autenticación de las consultas administrativas', () => {
  const identity = new SignedUser();
  let guard: PricingReadGuard;
  beforeAll(async () => {
    await identity.start();
    guard = new PricingReadGuard({
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: 'unused',
      databaseSsl: false,
      auth: { issuer: identity.issuer, jwksUrl: identity.issuer + '/jwks' },
    });
  });
  afterAll(() => identity.stop());
  afterEach(() => vi.restoreAllMocks());

  it('production demo confirmada ignora Authorization/G7 pero conserva validación de correlación', async () => {
    const config = validateEnvironment({
      NODE_ENV: 'production',
      PRICING_SVC_PORT: '3002',
      DATABASE_URL:
        'postgresql://pricing:fixture@localhost/fixture?sslmode=verify-full',
      GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      PRICING_DEMO_PRODUCTION_CONFIRMED: 'true',
    });
    const verifier = new PricingReadGuard(config);
    const remote = vi.spyOn(globalThis, 'fetch');
    const context = (headers: Record<string, string>) =>
      new ExecutionContextHost([
        { headers },
        { setHeader: vi.fn(), once: vi.fn() },
      ]);
    await expect(verifier.canActivate(context({}))).resolves.toBe(true);
    await expect(
      verifier.canActivate(context({ authorization: 'Bearer unused-invalid' })),
    ).resolves.toBe(true);
    await expect(
      verifier.canActivate(context({ 'x-correlation-id': 'invalid' })),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDACION' });
    expect(remote).not.toHaveBeenCalled();
    const authenticated = new PricingReadGuard(
      validateEnvironment({
        NODE_ENV: 'production',
        PRICING_SVC_PORT: '3002',
        DATABASE_URL:
          'postgresql://pricing:fixture@localhost/fixture?sslmode=verify-full',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'false',
        PRICING_DEMO_PRODUCTION_CONFIRMED: 'true',
      }),
    );
    await expect(authenticated.canActivate(context({}))).rejects.toMatchObject({
      status: 401,
      code: 'TOKEN_INVALIDO',
    });
  });

  it('acepta la firma real y el rol canónico; el cache permite lecturas dentro de su TTL', async () => {
    await expect(guard.authorize(identity.token())).resolves.toBeUndefined();
    await expect(guard.authorize(identity.token())).resolves.toBeUndefined();
  });
  it.each([
    { exp: 0 },
    { iss: 'https://other.invalid' },
    { tipo: 'servicio' },
    { sub: 'not-uuid' },
    { iat: 9999999999 },
    { nbf: 9999999999 },
    { jti: '' },
    { roles: 'GESTOR_COMERCIAL' },
  ])('rechaza claims inválidos %j', async (overrides) => {
    await expect(
      guard.authorize(identity.token(overrides)),
    ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });
  });
  it.each([
    { alg: 'none' },
    { kid: 'unknown' },
    { crit: ['other'] },
    { typ: 'other' },
  ])('rechaza cabecera %j', async (header) => {
    await expect(
      guard.authorize(identity.token({}, header)),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rechaza firma alterada, formato inválido y rol insuficiente', async () => {
    const parts = identity.token().split('.');
    parts[2] = Buffer.alloc(256).toString('base64url');
    for (const token of [parts.join('.'), 'not-a-token', 'x'.repeat(16385)])
      await expect(guard.authorize(token)).rejects.toMatchObject({
        status: 401,
      });
    await expect(
      guard.authorize(identity.token({ roles: ['OTRO'] })),
    ).rejects.toMatchObject({ status: 403, code: 'SCOPE_INSUFICIENTE' });
  });
  it('configuración ausente y JWKS inaccesible fallan cerrados', async () => {
    const config = {
      nodeEnv: 'test' as const,
      port: 3002,
      databaseUrl: 'unused',
      databaseSsl: false as const,
    };
    await expect(
      new PricingReadGuard(config).authorize(identity.token()),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      new PricingReadGuard({
        ...config,
        auth: { issuer: identity.issuer, jwksUrl: 'http://127.0.0.1:1/jwks' },
      }).authorize(identity.token()),
    ).rejects.toMatchObject({ status: 503, code: 'SERVICIO_NO_DISPONIBLE' });
  });

  it('al vencer el cache exige JWKS disponible y no reutiliza claves caducadas', async () => {
    const source = new SignedUser();
    await source.start();
    try {
      const verifier = new PricingReadGuard({
        nodeEnv: 'test',
        port: 3002,
        databaseUrl: 'unused',
        databaseSsl: false,
        auth: { issuer: source.issuer, jwksUrl: source.issuer + '/jwks' },
      });
      await verifier.authorize(source.token());
      await source.stop();
      await expect(verifier.authorize(source.token())).resolves.toBeUndefined();
      const clock = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(clock + 61000);
      await expect(verifier.authorize(source.token())).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      await source.stop();
    }
  });
});
