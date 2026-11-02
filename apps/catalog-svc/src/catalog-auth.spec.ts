import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign as signJwt } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CatalogAuthGuard,
  CatalogSecurityUnavailable,
  CatalogTokenRejected,
  CatalogTokenVerifier,
  RequireCatalogIdentity,
  readCatalogSecurityConfig,
} from './catalog-auth.js';

describe('Catalog JWT verification', () => {
  const issuer = 'http://localhost:8080/api/v1/auth';
  let server: Server;
  let origin: string;
  let verifier: CatalogTokenVerifier;
  let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  let publicJwk: Record<string, unknown>;

  beforeAll(async () => {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keyPair.privateKey;
    publicJwk = {
      ...(keyPair.publicKey.export({ format: 'jwk' }) as Record<
        string,
        unknown
      >),
      kid: 'catalog-test-key',
      alg: 'RS256',
      use: 'sig',
    };
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'max-age=60');
      if (request.url === '/.well-known/openid-configuration')
        response.end(
          JSON.stringify({
            issuer,
            jwks_uri: origin + '/.well-known/jwks.json',
          }),
        );
      else if (request.url === '/.well-known/jwks.json')
        response.end(JSON.stringify({ keys: [publicJwk] }));
      else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    origin = 'http://127.0.0.1:' + address.port;
    verifier = new CatalogTokenVerifier(
      readCatalogSecurityConfig({
        SECURITY_ISSUER: issuer,
        SECURITY_DISCOVERY_URL: origin + '/.well-known/openid-configuration',
        SECURITY_JWKS_URL: origin + '/.well-known/jwks.json',
      }),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function token(
    claims: Record<string, unknown> = {},
    key = privateKey,
    algorithm = 'RS256',
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: algorithm, kid: 'catalog-test-key' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: randomUUID(),
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        ...claims,
      }),
    ).toString('base64url');
    const body = header + '.' + payload;
    return (
      body +
      '.' +
      signJwt('RSA-SHA256', Buffer.from(body), key).toString('base64url')
    );
  }

  it('requires issuer, discovery and JWKS configuration together', () => {
    expect(() =>
      readCatalogSecurityConfig({ SECURITY_ISSUER: issuer }),
    ).toThrow();
    expect(readCatalogSecurityConfig({})).toBeUndefined();
  });

  it.each([null, [], 'not-an-object', 1])(
    'rejects a malformed JWT header %j as an invalid token',
    async (header) => {
      const encoded = Buffer.from(JSON.stringify(header)).toString('base64url');
      await expect(
        verifier.verify(encoded + '.e30.signature'),
      ).rejects.toBeInstanceOf(CatalogTokenRejected);
    },
  );

  it('verifies user tokens with RS256, exact issuer, UUID subject and roles', async () => {
    await expect(verifier.verify(token())).resolves.toMatchObject({
      kind: 'user',
      roles: ['GESTOR_COMERCIAL'],
    });
  });
  it.each(['~', '=', '+', '/'])(
    'rejects non-base64url characters in a JWT signature (%s)',
    async (suffix) => {
      await expect(verifier.verify(token() + suffix)).rejects.toBeInstanceOf(
        CatalogTokenRejected,
      );
    },
  );
  it('shares a cold discovery/JWKS load across 100 simultaneous verifications and recovers after failure', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const cold = new CatalogTokenVerifier(
        readCatalogSecurityConfig({
          SECURITY_ISSUER: issuer,
          SECURITY_DISCOVERY_URL: origin + '/.well-known/openid-configuration',
          SECURITY_JWKS_URL: origin + '/.well-known/jwks.json',
        }),
      );
      fetcher.mockRejectedValueOnce(new Error('Bearer private-network-detail'));
      await expect(cold.verify(token())).rejects.toBeInstanceOf(
        CatalogSecurityUnavailable,
      );
      fetcher.mockClear();
      await Promise.all(
        Array.from({ length: 100 }, () => cold.verify(token())),
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      fetcher.mockRestore();
    }
  });

  it('verifies service audience and space-delimited scopes without converting identity', async () => {
    await expect(
      verifier.verify(
        token({
          tipo: 'servicio',
          sub: 'modulo-despacho',
          aud: ['api-productos'],
          scope: 'catalogo:leer productos:fisicos:leer',
          roles: undefined,
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'service',
      subject: 'modulo-despacho',
      audiences: ['api-productos'],
      scopes: ['catalogo:leer', 'productos:fisicos:leer'],
    });
  });

  it('rejects invalid signature, algorithm, issuer and expired tokens', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(
      verifier.verify(token({}, other.privateKey)),
    ).rejects.toBeInstanceOf(CatalogTokenRejected);
    await expect(
      verifier.verify(token({}, privateKey, 'none')),
    ).rejects.toBeInstanceOf(CatalogTokenRejected);
    await expect(
      verifier.verify(token({ iss: 'http://attacker.invalid' })),
    ).rejects.toBeInstanceOf(CatalogTokenRejected);
    await expect(
      verifier.verify(token({ exp: Math.floor(Date.now() / 1000) - 1 })),
    ).rejects.toBeInstanceOf(CatalogTokenRejected);
  });

  it('rejects discovery that advertises a different issuer', async () => {
    const broken = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          issuer: 'http://other.invalid',
          jwks_uri: origin + '/.well-known/jwks.json',
        }),
      );
    });
    broken.listen(0, '127.0.0.1');
    await once(broken, 'listening');
    const address = broken.address();
    if (!address || typeof address === 'string') throw new Error();
    const invalidVerifier = new CatalogTokenVerifier(
      readCatalogSecurityConfig({
        SECURITY_ISSUER: issuer,
        SECURITY_DISCOVERY_URL: 'http://127.0.0.1:' + address.port,
        SECURITY_JWKS_URL: origin + '/.well-known/jwks.json',
      }),
    );
    await expect(invalidVerifier.verify(token())).rejects.toBeInstanceOf(
      CatalogSecurityUnavailable,
    );
    await new Promise<void>((resolve) => broken.close(() => resolve()));
  });

  it('applies route scopes and client allowlists after token verification', async () => {
    const handler = () => undefined;
    const descriptor = {
      configurable: true,
      enumerable: false,
      writable: true,
      value: handler,
    };
    RequireCatalogIdentity({
      identity: 'service',
      scope: 'productos:fisicos:leer',
      allowedClients: ['modulo-despacho'],
    })({}, 'read', descriptor);
    const guard = new CatalogAuthGuard(new Reflector(), verifier);
    const context = (authorization: string) =>
      ({
        getHandler: () => handler,
        getClass: () => class Target {},
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization } }),
        }),
      }) as never;
    const serviceToken = token({
      tipo: 'servicio',
      sub: 'modulo-despacho',
      aud: 'api-productos',
      scope: 'productos:fisicos:leer',
      roles: undefined,
    });
    await expect(
      guard.canActivate(context('Bearer ' + serviceToken)),
    ).resolves.toBe(true);
    await expect(guard.canActivate(context(''))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const wrongClient = token({
      tipo: 'servicio',
      sub: 'modulo-retail',
      aud: 'api-productos',
      scope: 'productos:fisicos:leer',
      roles: undefined,
    });
    await expect(
      guard.canActivate(context('Bearer ' + wrongClient)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
