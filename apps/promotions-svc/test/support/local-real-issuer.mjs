// Explicit disposable test issuer, never a production G7 replacement.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createPublicKey, randomUUID, sign } from 'node:crypto';
const key = readFileSync('/test/server.key');
const issuer = 'https://issuer:4443/api/v1/auth';
const jwk = {
  ...createPublicKey(key).export({ format: 'jwk' }),
  kid: 'local-real-services',
  alg: 'RS256',
  use: 'sig',
};
const grants = new Set([
  'catalogo:leer',
  'precios:leer',
  'inventario:disponibilidad:leer',
]);
const issued = [];
createServer(
  { key, cert: readFileSync('/test/server.crt') },
  async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/auth/.well-known/openid-configuration')
      return res.end(
        JSON.stringify({ issuer, jwks_uri: issuer + '/.well-known/jwks.json' }),
      );
    if (req.url === '/api/v1/auth/.well-known/jwks.json')
      return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/evidence' && req.method === 'GET')
      return res.end(JSON.stringify(issued));
    if (req.url !== '/api/v1/auth/token' || req.method !== 'POST') {
      res.statusCode = 404;
      return res.end('{}');
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        res.statusCode = 413;
        return res.end('{}');
      }
    }
    const form = new URLSearchParams(body),
      scope = form.get('scope');
    if (
      form.get('grant_type') !== 'client_credentials' ||
      form.get('client_id') !== 'modulo-productos' ||
      form.get('client_secret') !== process.env.LOCAL_CLIENT_SECRET ||
      !grants.has(scope)
    ) {
      res.statusCode = 401;
      return res.end('{}');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: issuer,
      sub: 'modulo-productos',
      client_id: 'modulo-productos',
      tipo: 'servicio',
      aud: ['api-productos'],
      scope,
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
    };
    const encoded = [{ alg: 'RS256', typ: 'JWT', kid: jwk.kid }, payload]
      .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
      .join('.');
    const accessToken =
      encoded +
      '.' +
      sign('RSA-SHA256', Buffer.from(encoded), key).toString('base64url');
    // Claims only: no bearer or secret in retained evidence.
    issued.push({
      sub: payload.sub,
      tipo: payload.tipo,
      aud: payload.aud,
      scope,
      jti: payload.jti,
    });
    res.end(
      JSON.stringify({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: 600,
        scopes: [scope],
      }),
    );
  },
).listen(4443, '0.0.0.0');
