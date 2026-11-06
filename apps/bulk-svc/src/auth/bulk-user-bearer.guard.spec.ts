import { BulkUserBearerGuard } from './bulk-user-bearer.guard.js';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';

function executionContext(
  headers: Record<string, string> = {},
  remoteAddress = '10.0.0.2',
  handlerName = 'unknownOperation',
) {
  const request = {
    headers,
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/plantilla',
    socket: { remoteAddress },
  };
  return {
    request,
    context: {
      getHandler: () => ({ name: handlerName }),
      switchToHttp: () => ({ getRequest: () => request }),
    } as never,
  };
}

describe('Bulk H4 userBearer and reversible demo policy', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    delete process.env.GATEWAY_DEMO_NO_AUTH_ENABLED;
    delete process.env.BULK_DEMO_GATEWAY_IPS;
    delete process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.G7_JWT_ISSUER;
    delete process.env.G6_SECURITY_MODE;
    delete process.env.BULK_PUBLIC_OPERATION_IDS;
    delete process.env.SIMULATED_AUTH_ISSUER;
    delete process.env.SIMULATED_AUTH_JWKS_URL;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllGlobals();
  });

  it('D-01/D-09: default is closed and absent credentials never fall back to demo', async () => {
    const { context } = executionContext();
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('D-02: a malformed or unverifiable bearer is rejected while demo is disabled', async () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'false';
    const { context } = executionContext({ authorization: 'Bearer not-a-jwt' });
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('rejects an otherwise valid locally signed RS256 token whose nbf is in the future', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    process.env.G7_JWT_ISSUER = 'test-issuer';
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const claims = encode({
      iss: 'test-issuer',
      sub: 'unit-test-subject',
      aud: 'api-productos',
      exp: Math.floor(Date.now() / 1000) + 600,
      nbf: Math.floor(Date.now() / 1000) + 600,
      roles: ['GESTOR_COMERCIAL'],
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const { context } = executionContext({
      authorization: `Bearer ${header}.${claims}.${signer.sign(privateKey, 'base64url')}`,
    });
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('rejects the legacy socket-IP demo bypass even when client identity headers are supplied', async () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context, request } = executionContext({
      authorization: 'Bearer forged',
      'x-user-id': 'admin',
      'x-roles': 'GESTOR_COMERCIAL',
    });
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
    expect(Reflect.get(request, 'user')).toBeUndefined();
  });

  it('D-06 boundary: a non-allowlisted peer cannot use demo mode', async () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context } = executionContext({}, '198.51.100.20');
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('permits only the configured template operation without credentials in phase 1', async () => {
    process.env.G6_SECURITY_MODE = 'PUBLIC_READ_ONLY';
    process.env.BULK_PUBLIC_OPERATION_IDS = 'descargarPlantillaProductos';
    const { context } = executionContext(
      {},
      '10.0.0.2',
      'descargarPlantillaProductos',
    );
    await expect(new BulkUserBearerGuard().canActivate(context)).resolves.toBe(
      true,
    );
  });

  it('verifies signed phase 2 JWTs through the independent JWKS and rejects them after switching to G7', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const issuer = 'https://simulated.test/issuer';
    const jwk = {
      ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
      kid: 'bulk-sim-key',
      alg: 'RS256',
      use: 'sig',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))),
    );
    process.env.NODE_ENV = 'test';
    process.env.G6_SECURITY_MODE = 'SIMULATED_AUTH';
    process.env.SIMULATED_AUTH_ISSUER = issuer;
    process.env.SIMULATED_AUTH_JWKS_URL = 'https://simulated.test/jwks';
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'bulk-sim-key' });
    const claims = encode({
      iss: issuer,
      sub: randomUUID(),
      aud: 'api-productos',
      exp: Math.floor(Date.now() / 1000) + 60,
      roles: ['GESTOR_COMERCIAL'],
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const token = `${header}.${claims}.${signer.sign(privateKey, 'base64url')}`;
    const { context } = executionContext({ authorization: `Bearer ${token}` });
    await expect(new BulkUserBearerGuard().canActivate(context)).resolves.toBe(
      true,
    );

    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    process.env.G7_JWT_ISSUER = 'https://g7.test/issuer';
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });
});
