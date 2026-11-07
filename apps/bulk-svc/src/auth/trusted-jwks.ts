import { createPublicKey, type JsonWebKey } from 'node:crypto';

export class JwksUnavailable extends Error {}
export class JwksTokenRejected extends Error {}
interface CachedKeys {
  keys: JsonWebKey[];
  expires: number;
  validUntil: number;
}
const cache = new Map<string, CachedKeys>();
const pending = new Map<string, Promise<JsonWebKey[]>>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function trustedJwksUrl(raw: string | undefined, nodeEnv?: string): URL {
  try {
    if (!raw || raw !== raw.trim()) throw new Error();
    const url = new URL(raw);
    const testHttp =
      nodeEnv === 'test' &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !testHttp) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error();
    return url;
  } catch {
    throw new JwksUnavailable();
  }
}

async function load(url: URL): Promise<JsonWebKey[]> {
  const existing = pending.get(url.href);
  if (existing) return existing;
  const work = (async () => {
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        !object(body) ||
        !Array.isArray(body.keys) ||
        body.keys.length > 100 ||
        !body.keys.every(object)
      )
        throw new Error();
      const keys = body.keys as JsonWebKey[];
      if (cache.size >= 4 && !cache.has(url.href))
        cache.delete(cache.keys().next().value!);
      const directives = response.headers.get('cache-control') ?? '';
      const seconds = /(?:no-store|no-cache)/i.test(directives)
        ? 0
        : Math.min(
            3600,
            Number(directives.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 3600),
          );
      cache.set(url.href, {
        keys,
        expires: Date.now() + Math.min(60, seconds) * 1000,
        validUntil: Date.now() + seconds * 1000,
      });
      return keys;
    } catch {
      throw new JwksUnavailable();
    }
  })();
  pending.set(url.href, work);
  try {
    return await work;
  } finally {
    if (pending.get(url.href) === work) pending.delete(url.href);
  }
}

/** Resolve trusted key material only. Callers still verify signature and claims.
 * Cache is scoped by the operator-configured endpoint, never token-supplied URLs.
 */
export async function trustedJwksPublicKey(
  token: string,
  rawUrl: string | undefined,
  nodeEnv?: string,
): Promise<string> {
  let header: Record<string, unknown>;
  try {
    const parts = token.split('.');
    if (
      token.length > 16384 ||
      parts.length !== 3 ||
      parts.some(
        (part) =>
          !/^[A-Za-z0-9_-]+$/.test(part) ||
          Buffer.from(part, 'base64url').toString('base64url') !== part,
      )
    )
      throw new Error();
    const decoded: unknown = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    );
    if (
      !object(decoded) ||
      decoded.alg !== 'RS256' ||
      typeof decoded.kid !== 'string' ||
      !decoded.kid ||
      decoded.kid.length > 256 ||
      decoded.crit !== undefined ||
      (decoded.typ !== undefined && decoded.typ !== 'JWT')
    )
      throw new Error();
    header = decoded;
  } catch {
    throw new JwksTokenRejected();
  }
  const url = trustedJwksUrl(rawUrl, nodeEnv),
    cached = cache.get(url.href);
  let keys: JsonWebKey[];
  try {
    keys =
      cached && cached.expires > Date.now() ? cached.keys : await load(url);
  } catch (error) {
    if (
      !cached ||
      cached.validUntil <= Date.now() ||
      !cached.keys.some((key) => key.kid === header.kid)
    )
      throw error;
    keys = cached.keys;
  }
  const matches = (values: JsonWebKey[]) =>
    values.filter(
      (key) =>
        key.kid === header.kid &&
        key.kty === 'RSA' &&
        (!key.alg || key.alg === 'RS256') &&
        (!key.use || key.use === 'sig') &&
        (!key.key_ops ||
          (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) &&
        !['d', 'p', 'q', 'dp', 'dq', 'qi'].some((property) => property in key),
    );
  let selected = matches(keys);
  if (!selected.length && cached && cached.expires > Date.now()) {
    keys = await load(url);
    selected = matches(keys);
  }
  if (selected.length !== 1) throw new JwksTokenRejected();
  try {
    const key = createPublicKey({ key: selected[0], format: 'jwk' });
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw new JwksTokenRejected();
  }
}
