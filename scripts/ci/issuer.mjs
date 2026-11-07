// Emisor efímero exclusivo de CI; no se incluye en las imágenes de aplicación.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'ci', use: 'sig', alg: 'RS256' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
createServer({ key: readFileSync('/certs/server.key'), cert: readFileSync('/certs/server.crt') }, async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/keys') return res.end(JSON.stringify({ keys: [key] }));
  if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer: 'https://issuer:3443', jwks_uri: 'https://issuer:3443/keys' }));
  const technical = req.url === '/api/v1/auth/token';
  if (technical) {
    let raw=''; for await (const chunk of req) raw += String(chunk);
    const form=new URLSearchParams(raw);
    if (req.method !== 'POST' || form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== 'modulo-productos' || form.get('client_secret') !== 'ci-only-technical-secret' || form.get('scope') !== 'catalogo:leer') {
      res.statusCode=401; res.end('{}'); return;
    }
  }
  const overrides = req.url === '/expired' ? { exp: 1 } : req.url === '/forbidden' ? { scope: 'invalid' } : {};
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ iss: 'https://issuer:3443', sub: technical ? 'modulo-productos' : 'modulo-marketplace', tipo: 'servicio', aud: ['api-productos'], scope: 'catalogo:leer', iat: now, exp: now + 600, jti: randomUUID(), ...overrides });
  const body = encode({ alg: 'RS256', kid: 'ci', typ: 'JWT' }) + '.' + payload;
  const token = body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url');
  res.end(JSON.stringify(technical ? {accessToken:token,tokenType:'Bearer',expiresIn:600,scopes:['catalogo:leer']} : {token}));
}).listen(3443, '0.0.0.0');
