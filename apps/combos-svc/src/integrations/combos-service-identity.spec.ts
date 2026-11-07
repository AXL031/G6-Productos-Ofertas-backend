import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  ComboTokenVerifier,
  SimulatedComboTokenVerifier,
} from '../http/combos-auth.js';
import { CombosServiceIdentity } from './combos-service-identity.js';

describe('CombosServiceIdentity', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = 'combos-m2m-test';
  const secret = 'local-only-fixture-secret';
  const original = new Map<string, string | undefined>();
  let issuer = '';
  let server: Server;
  let tokenRequests = 0;
  let fullGrants = false;
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const signToken = (scope: string) => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${encode({ alg: 'RS256', kid: keyId })}.${encode({
      iss: issuer,
      sub: 'modulo-productos',
      tipo: 'servicio',
      aud: fullGrants ? ['api-productos', 'api-seguridad'] : ['api-productos'],
      scope,
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
    })}`;
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url')}`;
  };

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'public, max-age=60');
      if (request.url === '/.well-known/openid-configuration') {
        response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
        return;
      }
      if (request.url === '/jwks') {
        response.end(
          JSON.stringify({
            keys: [
              {
                ...pair.publicKey.export({ format: 'jwk' }),
                kid: keyId,
                alg: 'RS256',
                use: 'sig',
              },
            ],
          }),
        );
        return;
      }
      if (request.url === '/token' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        const form = new URLSearchParams(body);
        tokenRequests += 1;
        if (
          form.get('grant_type') !== 'client_credentials' ||
          form.get('client_id') !== 'modulo-productos' ||
          form.get('client_secret') !== secret
        ) {
          response.writeHead(401).end('{}');
          return;
        }
        const scope = fullGrants
          ? 'catalogo:leer precios:leer tokens:introspeccion'
          : (form.get('scope') ?? '');
        response.end(
          JSON.stringify({
            accessToken: signToken(scope),
            tokenType: 'Bearer',
            expiresIn: 600,
            scopes: scope.split(' '),
          }),
        );
        return;
      }
      response.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const key of [
      'SECURITY_ISSUER',
      'SECURITY_DISCOVERY_URL',
      'SECURITY_JWKS_URL',
      'COMBOS_G7_TOKEN_URL',
      'COMBOS_G7_CLIENT_SECRET',
    ])
      original.set(key, process.env[key]);
    process.env.SECURITY_ISSUER = issuer;
    process.env.SECURITY_DISCOVERY_URL = `${issuer}/.well-known/openid-configuration`;
    process.env.SECURITY_JWKS_URL = `${issuer}/jwks`;
    process.env.COMBOS_G7_TOKEN_URL = `${issuer}/token`;
    process.env.COMBOS_G7_CLIENT_SECRET = secret;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('coalesces concurrent client credentials and caches scope-specific tokens', async () => {
    tokenRequests = 0;
    const identity = new CombosServiceIdentity(new ComboTokenVerifier());
    const values = await Promise.all(
      Array.from({ length: 40 }, () => identity.authorization('catalogo:leer')),
    );
    expect(new Set(values).size).toBe(1);
    expect(tokenRequests).toBe(1);
    const pricing = await identity.authorization('precios:leer');
    expect(pricing).not.toBe(values[0]);
    expect(tokenRequests).toBe(2);
    identity.invalidate('catalogo:leer');
    expect(await identity.authorization('catalogo:leer')).not.toBe(values[0]);
    expect(tokenRequests).toBe(3);
  });

  it('accepts every granted G7 scope while enforcing the scope required by the caller', async () => {
    fullGrants = true;
    try {
      const identity = new CombosServiceIdentity(new ComboTokenVerifier());
      const value = await identity.authorization('catalogo:leer');
      const claims = JSON.parse(
        Buffer.from(value.split('.')[1], 'base64url').toString(),
      );
      expect(claims.aud).toEqual(['api-productos', 'api-seguridad']);
      expect(claims.scope.split(' ')).toContain('precios:leer');
      await expect(identity.authorization('precios:leer')).resolves.toEqual(
        expect.any(String),
      );
    } finally {
      fullGrants = false;
    }
  });
  it('selects independent simulated client credentials and never reuses a token across phases', async () => {
    const simPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const simSecret = 'local-independent-sim-secret';
    const keys = [
      'G6_SECURITY_MODE',
      'COMBOS_SIMULATED_ISSUER',
      'COMBOS_SIMULATED_DISCOVERY_URL',
      'COMBOS_SIMULATED_JWKS_URL',
      'COMBOS_SIMULATED_TOKEN_URL',
      'COMBOS_SIMULATED_CLIENT_SECRET',
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    let simIssuer = '',
      simRequests = 0;
    const simServer = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/openid')
        return void response.end(
          JSON.stringify({ issuer: simIssuer, jwks_uri: simIssuer + '/jwks' }),
        );
      if (request.url === '/jwks')
        return void response.end(
          JSON.stringify({
            keys: [
              {
                ...simPair.publicKey.export({ format: 'jwk' }),
                kid: 'sim-key',
                alg: 'RS256',
                use: 'sig',
              },
            ],
          }),
        );
      if (request.url !== '/token' || request.method !== 'POST')
        return void response.writeHead(404).end('{}');
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      const form = new URLSearchParams(body);
      simRequests += 1;
      if (
        form.get('client_secret') !== simSecret ||
        form.get('client_id') !== 'modulo-productos'
      )
        return void response.writeHead(401).end('{}');
      const now = Math.floor(Date.now() / 1000),
        scope = form.get('scope')!;
      const input =
        encode({ alg: 'RS256', kid: 'sim-key' }) +
        '.' +
        encode({
          iss: simIssuer,
          sub: 'modulo-productos',
          client_id: 'modulo-productos',
          tipo: 'servicio',
          aud: 'api-productos',
          scope,
          iat: now,
          exp: now + 300,
          jti: randomUUID(),
        });
      const accessToken =
        input +
        '.' +
        sign('RSA-SHA256', Buffer.from(input), simPair.privateKey).toString(
          'base64url',
        );
      response.end(
        JSON.stringify({
          accessToken,
          tokenType: 'Bearer',
          expiresIn: 300,
          scopes: [scope],
        }),
      );
    });
    simServer.listen(0, '127.0.0.1');
    await once(simServer, 'listening');
    simIssuer = 'http://127.0.0.1:' + (simServer.address() as AddressInfo).port;
    try {
      process.env.G6_SECURITY_MODE = 'SIMULATED_AUTH';
      process.env.COMBOS_SIMULATED_ISSUER = simIssuer;
      process.env.COMBOS_SIMULATED_DISCOVERY_URL = simIssuer + '/openid';
      process.env.COMBOS_SIMULATED_JWKS_URL = simIssuer + '/jwks';
      process.env.COMBOS_SIMULATED_TOKEN_URL = simIssuer + '/token';
      process.env.COMBOS_SIMULATED_CLIENT_SECRET = simSecret;
      const identity = new CombosServiceIdentity(
        new ComboTokenVerifier(),
        new SimulatedComboTokenVerifier(),
      );
      const demo = await identity.authorization('catalogo:leer');
      expect(
        JSON.parse(Buffer.from(demo.split('.')[1], 'base64url').toString()).iss,
      ).toBe(simIssuer);
      process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
      const realProfile = await identity.authorization('catalogo:leer');
      expect(
        JSON.parse(
          Buffer.from(realProfile.split('.')[1], 'base64url').toString(),
        ).iss,
      ).toBe(issuer);
      expect(realProfile).not.toBe(demo);
      process.env.G6_SECURITY_MODE = 'SIMULATED_AUTH';
      expect(await identity.authorization('catalogo:leer')).toBe(demo);
      expect(simRequests).toBe(1);
      delete process.env.COMBOS_SIMULATED_CLIENT_SECRET;
      await expect(
        new CombosServiceIdentity(
          new ComboTokenVerifier(),
          new SimulatedComboTokenVerifier(),
        ).authorization('catalogo:leer'),
      ).rejects.toMatchObject({ reason: 'AUTH_NOT_CONFIGURED' });
      expect(simRequests).toBe(1);
    } finally {
      simServer.closeAllConnections();
      await new Promise<void>((resolve) => simServer.close(() => resolve()));
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  it('fails closed when the G7 client credential is absent', async () => {
    const previousSecret = process.env.COMBOS_G7_CLIENT_SECRET;
    delete process.env.COMBOS_G7_CLIENT_SECRET;
    try {
      const identity = new CombosServiceIdentity(new ComboTokenVerifier());
      await expect(
        identity.authorization('catalogo:leer'),
      ).rejects.toMatchObject({
        reason: 'AUTH_NOT_CONFIGURED',
      });
    } finally {
      if (previousSecret !== undefined)
        process.env.COMBOS_G7_CLIENT_SECRET = previousSecret;
    }
  });
});
