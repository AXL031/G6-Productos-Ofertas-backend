import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Reflector, type ExecutionContext } from '@nestjs/core';
import {
  ComboIdentityUnavailable,
  ComboTokenVerifier,
  CombosAuthGuard,
  RequireComboAccess,
  SimulatedComboTokenVerifier,
} from './combos-auth.js';

describe('Combos JWT security', () => {
  const priorEnv = {
    SECURITY_ISSUER: process.env.SECURITY_ISSUER,
    SECURITY_DISCOVERY_URL: process.env.SECURITY_DISCOVERY_URL,
    SECURITY_JWKS_URL: process.env.SECURITY_JWKS_URL,
    COMBOS_RESTRICTED_DEMO_ENABLED: process.env.COMBOS_RESTRICTED_DEMO_ENABLED,
    G6_SECURITY_MODE: process.env.G6_SECURITY_MODE,
    COMBOS_SIMULATED_ISSUER: process.env.COMBOS_SIMULATED_ISSUER,
    COMBOS_SIMULATED_DISCOVERY_URL: process.env.COMBOS_SIMULATED_DISCOVERY_URL,
    COMBOS_SIMULATED_JWKS_URL: process.env.COMBOS_SIMULATED_JWKS_URL,
  };
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const simulatedKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let current = first;
  let kid = 'combos-key-1';
  let issuer = '';
  let server: Server;
  let available = true;
  let jwksRequests = 0;

  const base64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (
    claims: Record<string, unknown> = {},
    pair = current,
    keyId = kid,
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${base64({ alg: 'RS256', kid: keyId })}.${base64({
      iss: issuer,
      sub: '00000000-0000-4000-8000-000000000001',
      tipo: 'acceso',
      aud: ['api-productos'],
      roles: ['admin'],
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      ...claims,
    })}`;
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url')}`;
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'public, max-age=60');
      if (!available) {
        response.writeHead(503).end('{}');
      } else if (request.url === '/.well-known/openid-configuration') {
        response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      } else if (request.url === '/sim/.well-known/openid-configuration') {
        response.end(
          JSON.stringify({
            issuer: `${issuer}/sim`,
            jwks_uri: `${issuer}/sim/jwks`,
          }),
        );
      } else if (request.url === '/jwks' || request.url === '/sim/jwks') {
        jwksRequests += 1;
        const signingKey = request.url === '/sim/jwks' ? simulatedKey : current;
        response.end(
          JSON.stringify({
            keys: [
              {
                ...signingKey.publicKey.export({ format: 'jwk' }),
                kid: request.url === '/sim/jwks' ? 'combos-sim-key' : kid,
                alg: 'RS256',
                use: 'sig',
              },
            ],
          }),
        );
      } else response.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.SECURITY_ISSUER = issuer;
    process.env.SECURITY_DISCOVERY_URL = `${issuer}/.well-known/openid-configuration`;
    process.env.SECURITY_JWKS_URL = `${issuer}/jwks`;
    process.env.COMBOS_SIMULATED_ISSUER = `${issuer}/sim`;
    process.env.COMBOS_SIMULATED_DISCOVERY_URL = `${issuer}/sim/.well-known/openid-configuration`;
    process.env.COMBOS_SIMULATED_JWKS_URL = `${issuer}/sim/jwks`;
    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    process.env.COMBOS_RESTRICTED_DEMO_ENABLED = 'false';
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('verifies RS256 issuer, API audience, identity type, timestamps and roles', async () => {
    const verifier = new ComboTokenVerifier();
    await expect(verifier.verify(token())).resolves.toMatchObject({
      kind: 'user',
      subject: '00000000-0000-4000-8000-000000000001',
      roles: ['admin'],
    });
    await expect(
      verifier.verify(token({ aud: 'wrong-api' })),
    ).rejects.toThrow();
    await expect(verifier.verify(token({ exp: 1 }))).rejects.toThrow();
    await expect(
      verifier.verify(token({ nbf: Math.floor(Date.now() / 1000) + 60 })),
    ).rejects.toThrow();
    await expect(verifier.verify(token({ tipo: 'demo' }))).rejects.toThrow();
    await expect(
      verifier.verify(token({ roles: undefined })),
    ).rejects.toThrow();
    await expect(
      verifier.verify(token({ iss: 'https://other.invalid' })),
    ).rejects.toThrow();
    await expect(verifier.verify(token({}, second))).rejects.toThrow();
  });

  it('refreshes JWKS once for key rotation and coalesces concurrent cold loads', async () => {
    const verifier = new ComboTokenVerifier();
    const before = jwksRequests;
    await Promise.all(
      Array.from({ length: 25 }, () => verifier.verify(token())),
    );
    expect(jwksRequests - before).toBe(1);
    current = second;
    kid = 'combos-key-2';
    await expect(verifier.verify(token())).resolves.toMatchObject({
      kind: 'user',
    });
    current = first;
    kid = 'combos-key-1';
  });

  it('returns an identity outage separately from a rejected token', async () => {
    const verifier = new ComboTokenVerifier();
    available = false;
    try {
      await expect(verifier.verify(token())).rejects.toBeInstanceOf(
        ComboIdentityUnavailable,
      );
    } finally {
      available = true;
    }
  });

  it.each([
    'listarCombosAdmin',
    'crearCombo',
    'obtenerCombo',
    'actualizarCombo',
    'desactivarCombo',
    'consultarDisponibilidadCombo',
  ])('requires a verified user principal for %s', async (operationId) => {
    const verifier = new ComboTokenVerifier();
    const simulatedVerifier = new SimulatedComboTokenVerifier();
    const guard = new CombosAuthGuard(
      new Reflector(),
      verifier,
      simulatedVerifier,
    );
    const handler = () => undefined;
    RequireComboAccess({ operationId, identity: 'user' })(
      { [operationId]: handler },
      operationId,
      Object.getOwnPropertyDescriptor({ [operationId]: handler }, operationId)!,
    );
    const context = (authorization?: string) =>
      ({
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            headers: authorization ? { authorization } : {},
            socket: { remoteAddress: '127.0.0.1' },
            method: 'GET',
            route: {
              path:
                operationId === 'obtenerCombo'
                  ? '/combos/:comboId'
                  : '/unmatched',
            },
          }),
        }),
      }) as unknown as ExecutionContext;
    const roleKey = `COMBOS_ALLOWED_ROLES_${operationId.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
    const priorRoles = process.env[roleKey];
    delete process.env[roleKey];
    await expect(
      guard.canActivate(context(`Bearer ${token()}`)),
    ).rejects.toMatchObject({ status: 403 });
    process.env[roleKey] = '';
    await expect(
      guard.canActivate(context(`Bearer ${token()}`)),
    ).rejects.toMatchObject({ status: 403 });
    process.env[roleKey] = 'combos:admin';
    await expect(
      guard.canActivate(
        context(`Bearer ${token({ roles: ['inventario:admin'] })}`),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      guard.canActivate(
        context(`Bearer ${token({ roles: ['combos:admin'] })}`),
      ),
    ).resolves.toBe(true);
    if (priorRoles === undefined) delete process.env[roleKey];
    else process.env[roleKey] = priorRoles;
    await expect(guard.canActivate(context())).rejects.toMatchObject({
      status: 401,
    });
    const service = token({
      tipo: 'servicio',
      sub: 'modulo-productos',
      scope: 'combos:leer',
    });
    await expect(
      guard.canActivate(context(`Bearer ${service}`)),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('selects simulated issuer only in SIMULATED_AUTH and leaves public reads closed', async () => {
    const operationId = 'obtenerCombo';
    const handler = () => undefined;
    RequireComboAccess({ operationId, identity: 'user' })(
      { [operationId]: handler },
      operationId,
      Object.getOwnPropertyDescriptor({ [operationId]: handler }, operationId)!,
    );
    const guard = new CombosAuthGuard(
      new Reflector(),
      new ComboTokenVerifier(),
      new SimulatedComboTokenVerifier(),
    );
    const ctx = (authorization?: string) =>
      ({
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            headers: authorization ? { authorization } : {},
            socket: { remoteAddress: '127.0.0.1' },
            method: 'GET',
            route: { path: '/combos/:comboId' },
          }),
        }),
      }) as unknown as ExecutionContext;
    process.env.G6_SECURITY_MODE = 'SIMULATED_AUTH';
    process.env.COMBOS_ALLOWED_ROLES_OBTENER_COMBO = 'admin';
    const simulated = token(
      { iss: `${issuer}/sim` },
      simulatedKey,
      'combos-sim-key',
    );
    await expect(guard.canActivate(ctx(`Bearer ${simulated}`))).resolves.toBe(
      true,
    );
    await expect(
      guard.canActivate(ctx(`Bearer ${token()}`)),
    ).rejects.toMatchObject({ status: 401 });
    process.env.G6_SECURITY_MODE = 'PUBLIC_READ_ONLY';
    await expect(guard.canActivate(ctx())).rejects.toMatchObject({
      status: 401,
    });
    process.env.COMBOS_ALLOWED_ROLES_OBTENER_COMBO = 'combos:admin';
    await expect(
      guard.canActivate(ctx(`Bearer ${token({ roles: ['combos:admin'] })}`)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(ctx(`Bearer ${token({ roles: ['pricing:admin'] })}`)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      guard.canActivate(ctx(`Bearer ${simulated}`)),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      guard.canActivate(ctx(`Bearer ${token()}`)),
    ).rejects.toMatchObject({ status: 403 });
    process.env.COMBOS_PUBLIC_READ_OPERATIONS = 'obtenerCombo';
    await expect(guard.canActivate(ctx())).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      guard.canActivate(ctx(`Bearer ${token({ roles: ['combos:admin'] })}`)),
    ).resolves.toBe(true);
    delete process.env.COMBOS_PUBLIC_READ_OPERATIONS;
    delete process.env.COMBOS_ALLOWED_ROLES_OBTENER_COMBO;
    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
  });

  it('allows contract-listed M2M only on the two read operations with an explicit client grant', async () => {
    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    process.env.COMBOS_ALLOWED_CLIENTS_COMBOS_READ = 'modulo-productos';
    const verifier = new ComboTokenVerifier();
    const guard = new CombosAuthGuard(
      new Reflector(),
      verifier,
      new SimulatedComboTokenVerifier(),
    );
    const run = async (
      operationId: string,
      path: string,
      client: string,
      identity: 'user' | 'user_or_service' = 'user_or_service',
    ) => {
      const handler = () => undefined;
      RequireComboAccess({
        operationId,
        identity,
        ...(identity === 'user_or_service' ? { scope: 'combos:leer' } : {}),
      })(
        { [operationId]: handler },
        operationId,
        Object.getOwnPropertyDescriptor(
          { [operationId]: handler },
          operationId,
        )!,
      );
      const auth = token({
        tipo: 'servicio',
        sub: client,
        scope: 'combos:leer',
      });
      const ctx = {
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: `Bearer ${auth}` },
            socket: { remoteAddress: '127.0.0.1' },
            method: 'GET',
            route: { path },
          }),
        }),
      } as unknown as ExecutionContext;
      return guard.canActivate(ctx);
    };
    await expect(
      run('obtenerCombo', '/combos/:comboId', 'modulo-productos'),
    ).resolves.toBe(true);
    await expect(
      run(
        'consultarDisponibilidadCombo',
        '/combos/:comboId/disponibilidad',
        'modulo-productos',
      ),
    ).resolves.toBe(true);
    await expect(
      run('obtenerCombo', '/combos/:comboId', 'otro-modulo'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      run('actualizarCombo', '/combos/:comboId', 'modulo-productos', 'user'),
    ).rejects.toMatchObject({ status: 403 });
    delete process.env.COMBOS_ALLOWED_CLIENTS_COMBOS_READ;
  });
});
