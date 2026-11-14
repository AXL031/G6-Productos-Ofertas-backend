import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createH4SkuListener } from './h4-sku-listener.js';
import { createH4CatalogClient } from '../../pricing-svc/src/http/h4-catalog-client.js';
import { CatalogContextHttp } from '../../pricing-svc/src/http/catalog-context.js';
import type { PricingConfig } from '../../pricing-svc/src/config/environment.js';

const now = Date.parse('2026-11-07T20:00:00Z');
const until = new Date(now + 120_000).toISOString();
const sku = 'DEMO-1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const { privateKey: otherKey } = generateKeyPairSync('ed25519');
const dir = mkdtempSync(join(tmpdir(), 'g6-h4-tls-'));
const file = (name: string) => join(dir, name);
const openssl = (...args: string[]) =>
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
let listener: NonNullable<ReturnType<typeof createH4SkuListener>>;
let client: NonNullable<ReturnType<typeof createH4CatalogClient>>;
let env: NodeJS.ProcessEnv;

function certificate(name: string) {
  openssl(
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=' + name,
    '-keyout',
    name + '.key',
    '-out',
    name + '.csr',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    name + '.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '1',
    '-out',
    name + '.crt',
    '-extfile',
    name + '.ext',
  );
}

describe('Pricing a Catalog por HTTPS privado con identidad H4', () => {
  beforeAll(async () => {
    writeFileSync(
      file('sign.key'),
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
    );
    writeFileSync(
      file('verify.pub'),
      publicKey.export({ type: 'spki', format: 'pem' }),
    );
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=G6 test CA',
      '-days',
      '1',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
    );
    writeFileSync(
      file('server.ext'),
      'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
    );
    writeFileSync(file('pricing.ext'), 'extendedKeyUsage=clientAuth\n');
    writeFileSync(file('other.ext'), 'extendedKeyUsage=clientAuth\n');
    for (const name of ['server', 'pricing', 'other']) certificate(name);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    listener = createH4SkuListener(
      async (requested) => {
        if (requested !== sku) throw new NotFoundException();
        return {
          sku,
          productId: 'fixture-id',
          isVariant: false,
          active: true,
          eligible: true,
        };
      },
      {
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        CATALOG_H4_SKU_ENABLED: 'true',
        CATALOG_H4_SKU_UNTIL: until,
        CATALOG_H4_SKU_BIND_HOST: '127.0.0.1',
        CATALOG_H4_SKU_PORT: '3443',
        CATALOG_H4_SKU_PRICING_CERT_SHA256: new X509Certificate(
          readFileSync(file('pricing.crt')),
        ).fingerprint256,
        CATALOG_H4_SKU_VERIFY_KEY_FILE: file('verify.pub'),
        CATALOG_H4_SKU_TLS_CA_FILE: file('ca.crt'),
        CATALOG_H4_SKU_TLS_CERT_FILE: file('server.crt'),
        CATALOG_H4_SKU_TLS_KEY_FILE: file('server.key'),
      },
    )!;
    await new Promise<void>((resolve) =>
      listener.server.listen(0, listener.host, resolve),
    );
    const { port } = listener.server.address() as AddressInfo;
    env = {
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      PRICING_H4_SKU_ENABLED: 'true',
      PRICING_H4_SKU_UNTIL: until,
      PRICING_H4_SKU_ORIGIN: 'https://127.0.0.1:' + port,
      PRICING_H4_SKU_SIGNING_KEY_FILE: file('sign.key'),
      PRICING_H4_SKU_TLS_CA_FILE: file('ca.crt'),
      PRICING_H4_SKU_TLS_CERT_FILE: file('pricing.crt'),
      PRICING_H4_SKU_TLS_KEY_FILE: file('pricing.key'),
    };
    client = createH4CatalogClient(env)!;
  }, 20_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (listener?.server.listening) {
      await new Promise<void>((resolve) =>
        listener.server.close(() => resolve()),
      );
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function modified(changes: Record<string, unknown>, key = privateKey) {
    const [h, p] = client.issue(sku, now).split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    const encoded = Buffer.from(
      JSON.stringify({ ...claims, ...changes }),
    ).toString('base64url');
    const input = h + '.' + encoded;
    return (
      input + '.' + sign(null, Buffer.from(input), key).toString('base64url')
    );
  }

  async function status(token?: string, target = sku, transport = client) {
    const res = await transport.get(
      target,
      token ? { Authorization: 'Bearer ' + token } : {},
    );
    await res.text();
    return res.status;
  }

  it('válido', async () => {
    const pricing = new CatalogContextHttp(
      { securityMode: 'G7_AUTHENTICATED' } as PricingConfig,
      async (requested) => client.issue(requested!),
      client,
    );
    expect(await pricing.resolve(sku)).toMatchObject({
      sku,
      productId: 'fixture-id',
    });
  });
  it('ausente', async () => expect(await status()).toBe(401));
  it('firma ajena', async () =>
    expect(await status(modified({}, otherKey))).toBe(401));
  it('audiencia errónea', async () =>
    expect(await status(modified({ aud: 'public-gateway' }))).toBe(401));
  it('permiso insuficiente', async () =>
    expect(await status(modified({ scope: 'otro' }))).toBe(403));
  it('rol humano', async () =>
    expect(await status(modified({ roles: ['GESTOR_COMERCIAL'] }))).toBe(403));
  it('identidad distinta', async () =>
    expect(await status(modified({ sub: 'otra-app' }))).toBe(401));
  it('ruta administrativa', async () => {
    const { request } = await import('node:https');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        env.PRICING_H4_SKU_ORIGIN + '/api/v1/cupones',
        {
          ca: readFileSync(file('ca.crt')),
          cert: readFileSync(file('pricing.crt')),
          key: readFileSync(file('pricing.key')),
          headers: { Authorization: 'Bearer ' + client.issue(sku) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
  });
  it('SKU distinto', async () =>
    expect(await status(client.issue(sku), 'OTHER')).toBe(403));
  it('ingreso sin certificado Pricing', async () => {
    const other = createH4CatalogClient({
      ...env,
      PRICING_H4_SKU_TLS_CERT_FILE: file('other.crt'),
      PRICING_H4_SKU_TLS_KEY_FILE: file('other.key'),
    })!;
    expect(await status(client.issue(sku), sku, other)).toBe(401);
  });
  it('flag deshabilitado', () =>
    expect(createH4CatalogClient({})).toBeUndefined());
  it('JWT vencido', async () =>
    expect(await status(client.issue(sku, now - 61_000))).toBe(401));
  it('corte H4', async () => {
    const token = client.issue(sku);
    vi.mocked(Date.now).mockReturnValueOnce(Date.parse(until));
    expect(await status(token)).toBe(401);
  });
  it('SKU inexistente usa el 404 contractual y Pricing devuelve null', async () => {
    const pricing = new CatalogContextHttp(
      { securityMode: 'G7_AUTHENTICATED' } as PricingConfig,
      async (requested) => client.issue(requested!),
      client,
    );
    expect(await pricing.resolve('MISSING')).toBeNull();
  });
  it('rechaza el listener si se solicita un bind público', () => {
    expect(() =>
      createH4SkuListener(async () => null!, {
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        CATALOG_H4_SKU_ENABLED: 'true',
        CATALOG_H4_SKU_UNTIL: until,
        CATALOG_H4_SKU_BIND_HOST: '0.0.0.0',
        CATALOG_H4_SKU_PORT: '3443',
      }),
    ).toThrow('Configuración H4 Catalog inválida');
  });
  it('rechaza HTTPS si el nombre no coincide con el certificado', async () => {
    const other = createH4CatalogClient({
      ...env,
      PRICING_H4_SKU_ORIGIN: env.PRICING_H4_SKU_ORIGIN!.replace(
        '127.0.0.1',
        'localhost',
      ),
    })!;
    await expect(status(client.issue(sku), sku, other)).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });
});
