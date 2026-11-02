// Emisor efímero exclusivo de CI; no se incluye en las imágenes de aplicación.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'ci', use: 'sig', alg: 'RS256' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
createServer({ key: readFileSync('/certs/server.key'), cert: readFileSync('/certs/server.crt') }, (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/keys') return res.end(JSON.stringify({ keys: [key] }));
  if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer: 'https://issuer:3443', jwks_uri: 'https://issuer:3443/keys' }));
  const overrides = req.url === '/expired' ? { exp: 1 } : req.url === '/forbidden' ? { scope: 'invalid' } : {};
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ iss: 'https://issuer:3443', sub: 'modulo-marketplace', tipo: 'servicio', aud: ['api-productos'], scope: 'catalogo:leer', iat: now, exp: now + 600, jti: randomUUID(), ...overrides });
  const body = encode({ alg: 'RS256', kid: 'ci', typ: 'JWT' }) + '.' + payload;
  res.end(JSON.stringify({ token: body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url') }));
}).listen(3443, '0.0.0.0');
