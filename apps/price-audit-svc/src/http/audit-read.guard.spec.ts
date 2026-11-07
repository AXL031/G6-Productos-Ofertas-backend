import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEnvironment } from '../config/environment.js';
import { AuditHttpError } from './audit-http.error.js';
import { AuditReadGuard } from './audit-read.guard.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = keys.publicKey.export({ format: 'jwk' });
const now = () => Math.floor(Date.now() / 1000);

describe('Price Audit JWT humano en fases G7 y SIMULATED_AUTH', () => {
  let server: Server | undefined;
  let origin: string;

  afterEach(async () => {
    if (server?.listening) {
      server.close();
      await once(server, 'close');
    }
    server = undefined;
  });

  async function issuer(): Promise<string> {
    server = createServer((request, response) => {
      if (request.url !== '/jwks') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          keys: [
            { ...publicJwk, kid: 'phase-test-key', alg: 'RS256', use: 'sig' },
          ],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    origin = `http://127.0.0.1:${address.port}`;
    return origin;
  }

  function token(issuerUrl: string, overrides: Record<string, unknown> = {}) {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'phase-test-key' });
    const claims = encode({
      iss: issuerUrl,
      sub: '74ed2f19-7e70-4915-a6f6-bbc691b82587',
      tipo: 'acceso',
      iat: now(),
      exp: now() + 300,
      jti: 'phase-test-jti',
      roles: ['GESTOR_COMERCIAL'],
      ...overrides,
    });
    const input = `${header}.${claims}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  }

  function config(mode: 'G7_AUTHENTICATED' | 'SIMULATED_AUTH', iss: string) {
    return validateEnvironment({
      NODE_ENV: 'test',
      PRICE_AUDIT_SVC_PORT: '3003',
      DATABASE_URL: 'postgresql://audit:secret@127.0.0.1/audit_test',
      AUTH_ISSUER: 'https://g7.test/api/v1/auth',
      AUTH_JWKS_URL: `${origin}/jwks`,
      G6_SECURITY_MODE: mode,
      SIMULATED_AUTH_ISSUER: iss,
      SIMULATED_AUTH_JWKS_URL: `${origin}/jwks`,
    });
  }

  it('acepta RS256 humano sin aud en ambas fases y cambia issuer por configuración', async () => {
    const localIssuer = await issuer();
    const g7 = new AuditReadGuard(
      config('G7_AUTHENTICATED', 'https://g7.test/api/v1/auth'),
    );
    const simulated = new AuditReadGuard(config('SIMULATED_AUTH', localIssuer));
    const human = token('https://g7.test/api/v1/auth');
    expect(await g7.authorize(human)).toBe(
      '74ed2f19-7e70-4915-a6f6-bbc691b82587',
    );
    await expect(simulated.authorize(human)).rejects.toBeInstanceOf(
      AuditHttpError,
    );
    expect(await simulated.authorize(token(localIssuer))).toBe(
      '74ed2f19-7e70-4915-a6f6-bbc691b82587',
    );
  });

  it('rechaza firma, issuer, expiración, tipo y rol incorrectos', async () => {
    const localIssuer = await issuer();
    const guard = new AuditReadGuard(config('SIMULATED_AUTH', localIssuer));
    const assertUnauthorized = (jwt: string) =>
      expect(guard.authorize(jwt)).rejects.toMatchObject({ status: 401 });
    await assertUnauthorized(token('https://wrong.test'));
    await assertUnauthorized(token(localIssuer, { exp: now() - 1 }));
    await assertUnauthorized(token(localIssuer, { tipo: 'servicio' }));
    await expect(
      guard.authorize(token(localIssuer, { roles: [] })),
    ).rejects.toMatchObject({ status: 403 });
    const malformed = token(localIssuer).split('.');
    malformed[2] = Buffer.from('wrong-signature').toString('base64url');
    await assertUnauthorized(malformed.join('.'));
  });
});
