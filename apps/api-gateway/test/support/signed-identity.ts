import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import {
  GatewayIdentity,
  SignedIdentityVerifier,
  type JwtClaims,
} from '../../src/routing/gateway-identity.js';
import type { GatewaySettings } from '../../src/routing/gateway-settings.js';

export function createSignedIdentity(settings: GatewaySettings) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicKeyPem = String(
    publicKey.export({ type: 'spki', format: 'pem' }),
  );
  const key = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'isolated-test-key',
    alg: 'RS256',
    use: 'sig',
  };
  const verifier = new SignedIdentityVerifier(
    'https://isolated.test/issuer',
    async () => [key],
  );
  class IsolatedIdentity extends GatewayIdentity {
    override authenticate(token: string): Promise<JwtClaims> {
      return verifier.verify(token);
    }
  }
  return {
    identity: new IsolatedIdentity(settings),
    verifier,
    key,
    publicKeyPem,
    token(
      overrides: Record<string, unknown> = {},
      headerOverrides: Record<string, unknown> = {},
    ) {
      const header = Buffer.from(
        JSON.stringify({
          alg: 'RS256',
          kid: key.kid,
          typ: 'JWT',
          ...headerOverrides,
        }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'https://isolated.test/issuer',
          sub: 'modulo-marketplace',
          tipo: 'servicio',
          aud: ['api-productos'],
          scope: 'catalogo:leer',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          jti: randomUUID(),
          ...overrides,
        }),
      ).toString('base64url');
      return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    },
  };
}
