#!/usr/bin/env node
/**
 * Emisor OIDC/JWKS simulado aislado para pruebas de Fase 2 (SIMULATED_AUTH).
 *
 * Garantías de seguridad (Requisito #5 de revisión):
 * 1. Prohibido exponer en Internet o enlazar en 0.0.0.0: el servidor HTTP interno
 *    solo acepta bind en loopback (127.0.0.1 / ::1).
 * 2. Prohibido emitir tokens privilegiados (ej. GESTOR_COMERCIAL o M2M) de forma
 *    pública o sin autorización:
 *    - No existe ningún endpoint HTTP para emitir tokens humanos (tipo=acceso / GESTOR_COMERCIAL).
 *    - El endpoint M2M `POST /api/v1/auth/token` exige `grant_type=client_credentials`,
 *      `client_id` registrado y `client_secret` (>= 16 caracteres) verificado con
 *      `timingSafeEqual`, y restringe `scope` a la lista autorizada por cliente.
 *    - La función CLI/programática `mintProfile` exige `adminSecret` (>= 16 caracteres)
 *      verificado con `timingSafeEqual`.
 * 3. El JWKS publicado contiene exclusivamente parámetros públicos RSA (`kty`, `use`,
 *    `alg`, `kid`, `n`, `e`), verificando la ausencia de componentes privados (`d`, `p`, `q`).
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function base64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function safeSecretEquals(expected, actual) {
  if (
    typeof expected !== 'string' ||
    typeof actual !== 'string' ||
    expected.length < 16
  ) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createDemoIssuer(options = {}) {
  const kid = options.kid ?? 'g6-demo-rs256-k1';
  const adminSecret = options.adminSecret;
  if (typeof adminSecret !== 'string' || adminSecret.trim().length < 16) {
    throw new Error(
      'DEMO_ISSUER_CONFIG_INVALID: adminSecret (>= 16 caracteres) es obligatorio para inicializar el emisor simulado.',
    );
  }

  const { publicKey, privateKey } = options.privateKeyPem
    ? {
        privateKey: createPrivateKey(options.privateKeyPem),
        publicKey: createPublicKey(createPrivateKey(options.privateKeyPem)),
      }
    : generateKeyPairSync('rsa', { modulusLength: 2048 });

  const exportedJwk = publicKey.export({ format: 'jwk' });
  const publicJwk = Object.freeze({
    kty: 'RSA',
    use: 'sig',
    alg: 'RS256',
    kid,
    n: exportedJwk.n,
    e: exportedJwk.e,
  });

  const registeredClients = new Map(
    Object.entries(options.clients ?? {}).map(([clientId, cfg]) => {
      if (
        !cfg ||
        typeof cfg.clientSecret !== 'string' ||
        cfg.clientSecret.length < 16 ||
        !Array.isArray(cfg.allowedScopes)
      ) {
        throw new Error(
          `DEMO_ISSUER_CONFIG_INVALID: configuración inválida para cliente ${clientId}`,
        );
      }
      return [
        clientId,
        {
          clientSecret: cfg.clientSecret,
          allowedScopes: Object.freeze([...cfg.allowedScopes]),
        },
      ];
    }),
  );

  function signClaims(claims) {
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(signingInput),
      privateKey,
    ).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  function mintProfile({ issuer, profile, secret }) {
    if (!safeSecretEquals(adminSecret, secret)) {
      throw new Error(
        'UNAUTHORIZED_MINT: se requiere secreto administrativo válido para emitir tokens de prueba.',
      );
    }
    if (!issuer) throw new Error('ISSUER_REQUIRED');
    const normalizedIssuer = issuer.replace(/\/+$/, '');
    const now = Math.floor(Date.now() / 1000);
    switch (profile) {
      case 'm2m-marketplace':
        return signClaims({
          iss: normalizedIssuer,
          sub: 'modulo-marketplace',
          aud: 'api-productos',
          tipo: 'servicio',
          scope: 'catalogo:leer',
          iat: now - 5,
          exp: now + 3600,
          jti: randomUUID(),
        });
      case 'm2m-productos':
        return signClaims({
          iss: normalizedIssuer,
          sub: 'modulo-productos',
          aud: 'api-productos',
          tipo: 'servicio',
          scope: 'catalogo:leer',
          iat: now - 5,
          exp: now + 3600,
          jti: randomUUID(),
        });
      case 'user-gestor':
        return signClaims({
          iss: normalizedIssuer,
          sub: '11111111-2222-4333-8444-555555555555',
          aud: 'api-productos',
          tipo: 'acceso',
          roles: ['GESTOR_COMERCIAL'],
          iat: now - 5,
          exp: now + 3600,
          jti: randomUUID(),
        });
      case 'user-sin-rol':
        return signClaims({
          iss: normalizedIssuer,
          sub: '22222222-2222-4333-8444-555555555555',
          aud: 'api-productos',
          tipo: 'acceso',
          roles: ['LECTOR_EXTERNO'],
          iat: now - 5,
          exp: now + 3600,
          jti: randomUUID(),
        });
      case 'invalid-scope':
        return signClaims({
          iss: normalizedIssuer,
          sub: 'modulo-marketplace',
          aud: 'api-productos',
          tipo: 'servicio',
          scope: 'sin:permiso',
          iat: now - 5,
          exp: now + 3600,
          jti: randomUUID(),
        });
      case 'expired':
        return signClaims({
          iss: normalizedIssuer,
          sub: 'modulo-marketplace',
          aud: 'api-productos',
          tipo: 'servicio',
          scope: 'catalogo:leer',
          iat: now - 7200,
          exp: now - 3600,
          jti: randomUUID(),
        });
      default:
        throw new Error(`UNKNOWN_PROFILE: ${profile}`);
    }
  }

  async function listenLocalOnly(host = '127.0.0.1', port = 0) {
    if (!['127.0.0.1', '::1'].includes(host)) {
      throw new Error(
        'PUBLIC_BIND_FORBIDDEN: el emisor simulado solo puede escuchar en loopback (127.0.0.1 o ::1).',
      );
    }
    let origin = '';
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'max-age=60');
      if (req.method === 'GET' && req.url === '/.well-known/openid-configuration') {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            issuer: `${origin}/api/v1/auth`,
            jwks_uri: `${origin}/.well-known/jwks.json`,
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/.well-known/jwks.json') {
        res.statusCode = 200;
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/auth/token') {
        const chunks = [];
        let length = 0;
        req.on('data', (chunk) => {
          length += chunk.length;
          if (length <= 4096) chunks.push(chunk);
        });
        req.on('end', () => {
          if (length > 4096) {
            res.statusCode = 400;
            res.end(JSON.stringify({ code: 'VALIDACION' }));
            return;
          }
          const params = new URLSearchParams(
            Buffer.concat(chunks).toString('utf8'),
          );
          const grantType = params.get('grant_type');
          const clientId = params.get('client_id') ?? '';
          const clientSecret = params.get('client_secret') ?? '';
          const scope = params.get('scope') ?? '';
          // Prohibido solicitar tokens humanos (acceso/roles) por el endpoint de token
          if (
            grantType !== 'client_credentials' ||
            params.has('roles') ||
            params.get('tipo') === 'acceso'
          ) {
            res.statusCode = 403;
            res.end(JSON.stringify({ code: 'SCOPE_INSUFICIENTE' }));
            return;
          }
          const client = registeredClients.get(clientId);
          if (!client || !safeSecretEquals(client.clientSecret, clientSecret)) {
            res.statusCode = 401;
            res.end(JSON.stringify({ code: 'TOKEN_INVALIDO' }));
            return;
          }
          const requestedScopes = scope.split(/\s+/).filter(Boolean);
          if (
            requestedScopes.length === 0 ||
            requestedScopes.some((s) => !client.allowedScopes.includes(s))
          ) {
            res.statusCode = 403;
            res.end(JSON.stringify({ code: 'SCOPE_INSUFICIENTE' }));
            return;
          }
          const now = Math.floor(Date.now() / 1000);
          const accessToken = signClaims({
            iss: `${origin}/api/v1/auth`,
            sub: clientId,
            aud: 'api-productos',
            tipo: 'servicio',
            scope: requestedScopes.join(' '),
            iat: now,
            exp: now + 300,
            jti: randomUUID(),
          });
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              accessToken,
              tokenType: 'Bearer',
              expiresIn: 300,
              scopes: requestedScopes,
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'NO_ENCONTRADO' }));
    });

    server.listen(port, host);
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('LISTEN_FAILED');
    origin = `http://${host === '::1' ? '[::1]' : host}:${addr.port}`;
    return {
      origin,
      issuer: `${origin}/api/v1/auth`,
      discoveryUrl: `${origin}/.well-known/openid-configuration`,
      jwksUrl: `${origin}/.well-known/jwks.json`,
      tokenUrl: `${origin}/api/v1/auth/token`,
      close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
    };
  }

  return {
    kid,
    publicJwk,
    exportPrivateKeyPem: () =>
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
    mintProfile,
    listenLocalOnly,
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      args[token.slice(2)] = argv[i + 1];
      i++;
    } else {
      args._.push(token);
    }
  }
  return args;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const adminSecret =
    args['admin-secret'] ?? process.env.DEMO_ISSUER_ADMIN_SECRET ?? '';

  if (command === 'init') {
    const issuer = args.issuer;
    const outDir = resolve(args['out-dir'] ?? './.demo-oidc');
    const keyFile = resolve(args['key-file'] ?? './.demo-oidc/private.pem');
    if (!issuer) {
      console.error(
        'Uso: demo-jwt-issuer.mjs init --issuer <url> --admin-secret <secreto>=16chars [--out-dir ...] [--key-file ...]',
      );
      process.exit(1);
    }
    const demo = createDemoIssuer({ adminSecret });
    const wellKnownDir = join(outDir, '.well-known');
    mkdirSync(wellKnownDir, { recursive: true });
    writeFileSync(keyFile, demo.exportPrivateKeyPem(), { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const normalizedIssuer = issuer.replace(/\/+$/, '');
    const jwksUri = `${normalizedIssuer}/.well-known/jwks.json`;
    writeFileSync(
      join(wellKnownDir, 'openid-configuration'),
      JSON.stringify(
        {
          issuer: normalizedIssuer,
          jwks_uri: jwksUri,
          id_token_signing_alg_values_supported: ['RS256'],
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      join(wellKnownDir, 'jwks.json'),
      JSON.stringify({ keys: [demo.publicJwk] }, null, 2) + '\n',
    );
    console.log(
      JSON.stringify(
        {
          status: 'initialized',
          issuer: normalizedIssuer,
          discoveryUrl: `${normalizedIssuer}/.well-known/openid-configuration`,
          jwksUrl: jwksUri,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (command === 'mint') {
    const issuer = args.issuer ?? '';
    const keyFile = resolve(args['key-file'] ?? './.demo-oidc/private.pem');
    const profile = args.profile ?? 'm2m-marketplace';
    const demo = createDemoIssuer({
      adminSecret,
      privateKeyPem: readFileSync(keyFile, 'utf8'),
    });
    const jwt = demo.mintProfile({ issuer, profile, secret: adminSecret });
    process.stdout.write(`${jwt}\n`);
    process.exit(0);
  }

  console.error('Comandos soportados: init | mint');
  process.exit(1);
}
