import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Local cryptographic fixtures only: not a token service or a Phase 2 implementation. */
export function createJwtFixture({ kid }: { kid: string }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  return {
    async listenLocalOnly(host: '127.0.0.1', port: number) {
      let issuer = '';
      const server = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/discovery')
          res.end(JSON.stringify({ issuer, jwks_uri: issuer + '/jwks' }));
        else if (req.url === '/jwks') res.end(JSON.stringify({ keys: [jwk] }));
        else if (req.url === '/api/v1/auth/token' && req.method === 'POST') {
          let form = '';
          for await (const chunk of req) form += String(chunk);
          const fields = new URLSearchParams(form);
          if (
            fields.get('grant_type') !== 'client_credentials' ||
            fields.get('client_id') !== 'modulo-productos' ||
            fields.get('client_secret') !== 'local-technical-fixture' ||
            fields.get('scope') !== 'catalogo:leer'
          ) {
            res.statusCode = 401;
            res.end('{}');
            return;
          }
          res.end(
            JSON.stringify({
              accessToken: this.mintProfile({
                issuer,
                profile: 'm2m-productos',
              }),
              tokenType: 'Bearer',
              expiresIn: 600,
              scopes: ['catalogo:leer'],
            }),
          );
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
      server.listen(port, host);
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture port');
      issuer = `http://127.0.0.1:${address.port}`;
      return {
        issuer,
        discoveryUrl: issuer + '/discovery',
        jwksUrl: issuer + '/jwks',
        close: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      };
    },
    mintProfile({ issuer, profile }: { issuer: string; profile: string }) {
      const now = Math.floor(Date.now() / 1000);
      const user = profile.startsWith('user-');
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: 'api-productos',
          sub: user
            ? '11111111-2222-4333-8444-555555555555'
            : profile === 'm2m-productos'
              ? 'modulo-productos'
              : 'modulo-marketplace',
          tipo: user ? 'acceso' : 'servicio',
          ...(user
            ? {
                roles: [
                  profile === 'user-gestor'
                    ? 'GESTOR_COMERCIAL'
                    : 'LECTOR_EXTERNO',
                ],
              }
            : {
                scope:
                  profile === 'invalid-scope' ? 'sin:permiso' : 'catalogo:leer',
              }),
          iat: profile === 'expired' ? now - 7200 : now - 5,
          exp: profile === 'expired' ? now - 3600 : now + 600,
          jti: randomUUID(),
        }),
      ).toString('base64url');
      const body = header + '.' + payload;
      return (
        body +
        '.' +
        sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')
      );
    },
  };
}
