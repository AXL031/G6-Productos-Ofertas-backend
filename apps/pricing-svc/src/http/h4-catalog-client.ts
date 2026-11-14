import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { Readable } from 'node:stream';

const cutoffH4 = Date.parse('2026-11-08T05:00:00Z');
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export function createH4CatalogClient(env: NodeJS.ProcessEnv = process.env) {
  if (env.PRICING_H4_SKU_ENABLED !== 'true') return undefined;

  const cutoff = Date.parse(env.PRICING_H4_SKU_UNTIL ?? '');
  const origin = new URL(env.PRICING_H4_SKU_ORIGIN ?? '');
  if (
    env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
    !Number.isFinite(cutoff) ||
    cutoff > cutoffH4 ||
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Configuración H4 Pricing inválida');
  }
  if (Date.now() >= cutoff) return undefined;
  const key = createPrivateKey(
    readFileSync(env.PRICING_H4_SKU_SIGNING_KEY_FILE ?? ''),
  );
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Clave H4 inválida');
  const tls = {
    ca: readFileSync(env.PRICING_H4_SKU_TLS_CA_FILE ?? ''),
    cert: readFileSync(env.PRICING_H4_SKU_TLS_CERT_FILE ?? ''),
    key: readFileSync(env.PRICING_H4_SKU_TLS_KEY_FILE ?? ''),
    rejectUnauthorized: true,
  };

  return {
    issue(sku: string, now = Date.now()): string {
      const iat = Math.floor(now / 1000);
      const exp = Math.min(iat + 60, Math.floor(cutoff / 1000));
      if (!sku || exp <= iat) throw new Error('Identidad H4 vencida');
      const header = encode({ alg: 'EdDSA', typ: 'g6-h4-internal+jwt' });
      const payload = encode({
        iss: 'urn:g6:h4:pricing-svc',
        sub: 'pricing-svc',
        aud: 'urn:g6:h4:catalog-svc',
        scope: 'catalogo:contexto-sku:leer',
        purpose: 'H4_INTERNAL_TEMPORARY',
        sku,
        iat,
        exp,
      });
      const content = header + '.' + payload;
      return (
        content +
        '.' +
        sign(null, Buffer.from(content), key).toString('base64url')
      );
    },
    get(sku: string, headers: Record<string, string>): Promise<Response> {
      const url = new URL(
        '/api/v1/productos/skus/' + encodeURIComponent(sku) + '/contexto',
        origin,
      );
      return new Promise((resolve, reject) => {
        const req = request(
          url,
          {
            ...tls,
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(2000),
          },
          (res) => {
            const resultHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') resultHeaders.set(name, value);
            }
            resolve(
              new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
                status: res.statusCode,
                headers: resultHeaders,
              }),
            );
          },
        );
        req.once('error', reject);
        req.end();
      });
    },
  };
}
