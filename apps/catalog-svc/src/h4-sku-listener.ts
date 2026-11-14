import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import {
  HttpException,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CatalogSkuContextController } from './catalog-sku-context.controller.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';

const maximumCutoff = Date.parse('2026-11-08T05:00:00Z');
const route = /^\/api\/v1\/productos\/skus\/([^/?]+)\/contexto$/;
const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const allowedClaims = [
  'iss',
  'sub',
  'aud',
  'scope',
  'sku',
  'iat',
  'exp',
  'purpose',
];

export function authorizeH4Sku(
  token: string,
  sku: string,
  key: KeyObject,
  cutoff: number,
  now = Date.now(),
): 200 | 401 | 403 {
  if (
    !Number.isFinite(cutoff) ||
    cutoff > maximumCutoff ||
    now >= cutoff ||
    token.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    return 401;
  try {
    const [h, p, signature] = token.split('.');
    const header = decode(h);
    if (
      header.alg !== 'EdDSA' ||
      header.typ !== 'g6-h4-internal+jwt' ||
      Object.keys(header).length !== 2 ||
      !verify(
        null,
        Buffer.from(h + '.' + p),
        key,
        Buffer.from(signature, 'base64url'),
      )
    )
      return 401;
    const claims = decode(p);
    const second = Math.floor(now / 1000);
    if (
      claims.iss !== 'urn:g6:h4:pricing-svc' ||
      claims.sub !== 'pricing-svc' ||
      claims.aud !== 'urn:g6:h4:catalog-svc' ||
      claims.purpose !== 'H4_INTERNAL_TEMPORARY' ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat > second ||
      claims.exp <= second ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 60 ||
      claims.exp * 1000 > cutoff
    )
      return 401;
    if (
      Object.keys(claims).some((claim) => !allowedClaims.includes(claim)) ||
      claims.scope !== 'catalogo:contexto-sku:leer' ||
      claims.sku !== sku
    )
      return 403;
    return 200;
  } catch {
    return 401;
  }
}

export function createH4SkuListener(
  lookup: CatalogSkuContextController['context'],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.CATALOG_H4_SKU_ENABLED !== 'true') return undefined;
  const cutoff = Date.parse(env.CATALOG_H4_SKU_UNTIL ?? '');
  const host = env.CATALOG_H4_SKU_BIND_HOST ?? '';
  const port = Number(env.CATALOG_H4_SKU_PORT);
  const pin = env.CATALOG_H4_SKU_PRICING_CERT_SHA256?.replace(
    /:/g,
    '',
  ).toLowerCase();
  if (
    env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
    !Number.isFinite(cutoff) ||
    cutoff > maximumCutoff ||
    isIP(host) !== 4 ||
    !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !/^[a-f0-9]{64}$/.test(pin ?? '')
  ) {
    throw new Error('Configuración H4 Catalog inválida');
  }
  if (Date.now() >= cutoff) return undefined;
  const key = createPublicKey(
    readFileSync(env.CATALOG_H4_SKU_VERIFY_KEY_FILE ?? ''),
  );
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Clave H4 inválida');

  const server = createServer(
    {
      ca: readFileSync(env.CATALOG_H4_SKU_TLS_CA_FILE ?? ''),
      cert: readFileSync(env.CATALOG_H4_SKU_TLS_CERT_FILE ?? ''),
      key: readFileSync(env.CATALOG_H4_SKU_TLS_KEY_FILE ?? ''),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    async (req, res) => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, {
          'content-type':
            status === 200 ? 'application/json' : 'application/problem+json',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(value));
      };
      const peer = req.socket as TLSSocket;
      const fingerprint = peer
        .getPeerCertificate()
        ?.fingerprint256?.replace(/:/g, '')
        .toLowerCase();
      if (!peer.authorized || fingerprint !== pin) {
        return send(401, { status: 401, code: 'TOKEN_INVALIDO' });
      }
      const path = req.method === 'GET' ? route.exec(req.url ?? '') : null;
      if (!path) return send(404, { status: 404 });
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return send(401, { status: 401, code: 'TOKEN_INVALIDO' });
      let sku: string;
      try {
        sku = decodeURIComponent(path[1]);
        if (encodeURIComponent(sku) !== path[1]) throw new Error();
      } catch {
        return send(400, { status: 400, code: 'VALIDACION' });
      }
      const status = authorizeH4Sku(token, sku, key, cutoff);
      if (status !== 200)
        return send(status, {
          status,
          code: status === 401 ? 'TOKEN_INVALIDO' : 'SCOPE_INSUFICIENTE',
        });
      try {
        send(
          200,
          await lookup(
            sku,
            typeof req.headers['x-correlation-id'] === 'string'
              ? req.headers['x-correlation-id']
              : undefined,
          ),
        );
      } catch (error) {
        const status = error instanceof HttpException ? error.getStatus() : 503;
        const code =
          status === 404
            ? 'SKU_NO_ENCONTRADO'
            : status === 400
              ? 'VALIDACION'
              : 'SERVICIO_NO_DISPONIBLE';
        send(status, { status, code });
      }
    },
  );
  return { server, host, port };
}

@Injectable()
export class H4SkuListener
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private server?: Server;

  constructor(private readonly repository: PostgresCatalogRepository) {}

  async onApplicationBootstrap() {
    const controller = new CatalogSkuContextController(this.repository);
    const listener = createH4SkuListener(controller.context.bind(controller));
    if (!listener) return;
    const { server, host, port } = listener;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  onApplicationShutdown() {
    this.server?.close();
  }
}
