import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'r01-https-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } finally {
    for (const file of [keyPath, certPath]) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    rmdirSync(dir);
  }
}

const scope = 'carga-masiva:contenidos:leer';

/** Local implementation of the G7 protocol surface used by Catalog. */
export async function claimCheckIdentityFixture() {
  const httpsOptions = certificate();
  const defaultCas = getCACertificates('default');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const kid = randomUUID();
  const secret = randomUUID();
  let requests = 0;
  const server = createServer(httpsOptions, async (request, response) => {
    const issuer =
      'https://127.0.0.1:' + (server.address() as AddressInfo).port;
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/discovery') {
      response.end(JSON.stringify({ issuer, jwks_uri: issuer + '/jwks' }));
    } else if (request.method === 'GET' && request.url === '/jwks') {
      response.end(
        JSON.stringify({
          keys: [
            {
              ...publicKey.export({ format: 'jwk' }),
              kid,
              alg: 'RS256',
              use: 'sig',
            },
          ],
        }),
      );
    } else if (
      request.method === 'POST' &&
      request.url === '/api/v1/auth/token'
    ) {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(
          Buffer.concat(chunks).toString('utf8'),
        );
        if (
          form.get('grant_type') !== 'client_credentials' ||
          form.get('client_id') !== 'catalog-svc' ||
          form.get('client_secret') !== secret ||
          form.get('scope') !== scope
        ) {
          response.writeHead(401).end('{}');
          return;
        }
        requests++;
        const now = Math.floor(Date.now() / 1000);
        const input = [
          { alg: 'RS256', kid, typ: 'JWT' },
          {
            iss: issuer,
            sub: 'catalog-svc',
            client_id: 'catalog-svc',
            tipo: 'servicio',
            scope,
            aud: 'api-productos',
            iat: now,
            exp: now + 120,
            jti: randomUUID(),
          },
        ]
          .map((value) =>
            Buffer.from(JSON.stringify(value)).toString('base64url'),
          )
          .join('.');
        const accessToken =
          input +
          '.' +
          sign('RSA-SHA256', Buffer.from(input), privateKey).toString(
            'base64url',
          );
        response.end(
          JSON.stringify({
            accessToken,
            tokenType: 'Bearer',
            expiresIn: 120,
            scopes: [scope],
          }),
        );
      } catch {
        response.writeHead(500).end('{}');
      }
    } else {
      response.writeHead(404).end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'https://127.0.0.1:' + (server.address() as AddressInfo).port;
  return {
    httpsOptions,
    origin,
    secret,
    requests: () => requests,
    trust: () => setDefaultCACertificates([...defaultCas, httpsOptions.cert]),
    async close() {
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        setDefaultCACertificates(defaultCas);
      }
    },
  };
}
