import { createServer, type Server } from 'node:http';
import {
  generateKeyPairSync,
  createSign,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { BulkUserBearerGuard } from './bulk-user-bearer.guard.js';

describe('G7 and independent simulated JWKS on real HTTP transport', () => {
  const g7 = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const simulated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const g7Issuer = 'https://g7.test/api/v1/auth',
    simulatedIssuer = 'https://simulator.test/issuer';
  let server: Server,
    base: string,
    generation = 0,
    status = 200;
  let providerKeys: object[] = [];
  const jwk = (key: KeyObject, kid = 'g7-key') => ({
    ...key.export({ format: 'jwk' }),
    kid,
    alg: 'RS256',
    use: 'sig',
  });

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: providerKeys }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    base = 'http://127.0.0.1:' + address.port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    status = 200;
    providerKeys = [jwk(g7.publicKey)];
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
    vi.stubEnv('G7_JWT_ISSUER', g7Issuer);
    vi.stubEnv('G7_JWT_JWKS_URL', base + '/keys/' + ++generation);
    vi.stubEnv('G7_JWT_PUBLIC_KEY', undefined);
    vi.stubEnv('JWT_PUBLIC_KEY', undefined);
    vi.stubEnv('SIMULATED_AUTH_ISSUER', simulatedIssuer);
    vi.stubEnv('SIMULATED_AUTH_JWKS_URL', base + '/simulated/' + generation);
    vi.stubEnv('BULK_PUBLIC_OPERATION_IDS', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  function token(
    overrides: Record<string, unknown> = {},
    key = g7.privateKey,
    header: Record<string, unknown> = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const first = encode({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'g7-key',
      ...header,
    });
    const second = encode({
      iss: g7Issuer,
      tipo: 'acceso',
      sub: '10000000-0000-4000-8000-000000000001',
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      roles: ['GESTOR_COMERCIAL'],
      ...overrides,
    });
    const signer = createSign('RSA-SHA256');
    signer.update(first + '.' + second);
    return first + '.' + second + '.' + signer.sign(key, 'base64url');
  }
  function execution(authorization?: string) {
    const request = {
      method: 'GET',
      path: '/api/v1/carga-masiva/productos/plantilla',
      headers: authorization === undefined ? {} : { authorization },
    };
    function descargarPlantillaProductos() {}
    const context = {
      getHandler: () => descargarPlantillaProductos,
      getClass: () => class TestController {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { request, context };
  }
  function authorize(authorization?: string) {
    const { context } = execution(authorization);
    return Promise.resolve().then(() =>
      new BulkUserBearerGuard().canActivate(context),
    );
  }

  it('accepts RS256 human G7 tokens without inventing aud and without a static key', async () => {
    await expect(authorize('Bearer ' + token())).resolves.toBe(true);
  });
  it.each(['null', '[]', '"text"'])(
    'returns 401 for non-object JWT data %s',
    async (value) => {
      const parts = token().split('.');
      const encoded = Buffer.from(value).toString('base64url');
      await expect(
        authorize('Bearer ' + [encoded, parts[1], parts[2]].join('.')),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        authorize('Bearer ' + [parts[0], encoded, parts[2]].join('.')),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
  it('uses an independent simulated issuer and keys only in SIMULATED_AUTH', async () => {
    vi.stubEnv('G6_SECURITY_MODE', 'SIMULATED_AUTH');
    providerKeys = [jwk(simulated.publicKey, 'sim-key')];
    const demo = token({ iss: simulatedIssuer }, simulated.privateKey, {
      kid: 'sim-key',
    });
    await expect(authorize('Bearer ' + demo)).resolves.toBe(true);
    vi.stubEnv('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
    await expect(authorize('Bearer ' + demo)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects an expired token, wrong issuer and altered signature', async () => {
    await expect(
      authorize('Bearer ' + token({ exp: Math.floor(Date.now() / 1000) - 1 })),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authorize('Bearer ' + token({ iss: simulatedIssuer })),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authorize('Bearer ' + token({}, simulated.privateKey)),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects unsupported algorithms and missing or ambiguous key IDs', async () => {
    await expect(
      authorize('Bearer ' + token({}, g7.privateKey, { alg: 'HS256' })),
    ).rejects.toMatchObject({ status: 401 });
    providerKeys = [jwk(g7.publicKey), jwk(g7.publicKey)];
    await expect(authorize('Bearer ' + token())).rejects.toMatchObject({
      status: 401,
    });
  });
  it('returns 403 for a valid human without GESTOR_COMERCIAL', async () => {
    await expect(
      authorize('Bearer ' + token({ roles: [] })),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('fails 503 on provider failure even when a matching static key is available', async () => {
    vi.stubEnv(
      'G7_JWT_PUBLIC_KEY',
      g7.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    status = 503;
    await expect(authorize('Bearer ' + token())).rejects.toMatchObject({
      status: 503,
    });
  });
  it('removes anonymous exceptions in phases 2/3 and validates supplied JWT in phase 1', async () => {
    vi.stubEnv('BULK_PUBLIC_OPERATION_IDS', 'descargarPlantillaProductos');
    for (const phase of ['G7_AUTHENTICATED', 'SIMULATED_AUTH']) {
      vi.stubEnv('G6_SECURITY_MODE', phase);
      await expect(authorize()).rejects.toMatchObject({ status: 401 });
    }
    vi.stubEnv('G6_SECURITY_MODE', 'PUBLIC_READ_ONLY');
    await expect(authorize()).resolves.toBe(true);
    await expect(
      authorize('Bearer ' + token({}, simulated.privateKey)),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('does not accept a technical identity on human-only Bulk operations', async () => {
    await expect(
      authorize(
        'Bearer ' +
          token({
            tipo: 'servicio',
            sub: 'modulo-productos',
            client_id: 'modulo-productos',
            aud: 'api-productos',
            scope: 'catalogo:leer',
          }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
