import { createServer, type Server } from 'node:http';
import {
  generateKeyPairSync,
  createSign,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InventoryAuthGuard } from './inventory-auth.guard.js';
import { UserAuthGuard } from './user-auth.guard.js';
import { REQUIRED_SCOPE_KEY, ALLOWED_CLIENTS_KEY } from './auth.constants.js';

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
    vi.stubEnv('INVENTORY_PUBLIC_OPERATION_IDS', undefined);
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
      path: '/api/v1/inventario/disponibilidad/comercial',
      headers: authorization === undefined ? {} : { authorization },
    };
    function consultarDisponibilidadComercial() {}
    const context = {
      getHandler: () => consultarDisponibilidadComercial,
      getClass: () => class TestController {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { request, context };
  }
  function authorize(authorization?: string) {
    const { context } = execution(authorization);
    return Promise.resolve().then(() =>
      new UserAuthGuard(new Reflector()).canActivate(context),
    );
  }

  it('accepts RS256 human G7 tokens without inventing aud and without a static key', async () => {
    await expect(authorize('Bearer ' + token())).resolves.toBe(true);
  });
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
  it('rejects future human iat/nbf claims without inventing an audience', async () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    for (const claims of [{ nbf: future }, { iat: future }])
      await expect(authorize('Bearer ' + token(claims))).rejects.toMatchObject({
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
    vi.stubEnv(
      'INVENTORY_PUBLIC_OPERATION_IDS',
      'consultarDisponibilidadComercial',
    );
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
  it('enforces service audience, scope and client separately from human roles', async () => {
    const { context } = execution();
    Reflect.defineMetadata(
      REQUIRED_SCOPE_KEY,
      'inventario:disponibilidad:leer',
      context.getHandler(),
    );
    Reflect.defineMetadata(
      ALLOWED_CLIENTS_KEY,
      ['modulo-marketplace'],
      context.getHandler(),
    );
    const service = {
      tipo: 'servicio',
      sub: 'modulo-marketplace',
      client_id: 'modulo-marketplace',
      aud: 'api-productos',
      scope: 'inventario:disponibilidad:leer',
    };
    const check = (claims: Record<string, unknown>) => {
      const { context: serviceContext } = execution(
        'Bearer ' + token({ ...service, ...claims }),
      );
      Reflect.defineMetadata(
        REQUIRED_SCOPE_KEY,
        'inventario:disponibilidad:leer',
        serviceContext.getHandler(),
      );
      Reflect.defineMetadata(
        ALLOWED_CLIENTS_KEY,
        ['modulo-marketplace'],
        serviceContext.getHandler(),
      );
      return new InventoryAuthGuard(new Reflector()).canActivate(
        serviceContext,
      );
    };
    await expect(check({})).resolves.toBe(true);
    const future = Math.floor(Date.now() / 1000) + 60;
    await expect(check({ nbf: future })).rejects.toMatchObject({ status: 401 });
    await expect(check({ iat: future })).rejects.toMatchObject({ status: 401 });
    await expect(check({ aud: 'api-seguridad' })).rejects.toMatchObject({
      status: 401,
    });
    await expect(check({ scope: 'otro:scope' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      check({ sub: 'modulo-retail', client_id: 'modulo-retail' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
