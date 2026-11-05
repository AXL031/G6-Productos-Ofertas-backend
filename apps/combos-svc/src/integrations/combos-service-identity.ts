import { Injectable } from '@nestjs/common';
import { ComboTokenVerifier } from '../http/combos-auth.js';
import { IntegrationFailure } from './catalog-sku-context.client.js';

type ServiceScope = 'catalogo:leer' | 'precios:leer';
interface CachedToken {
  value: string;
  expiresAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readTokenBody(response: Response): Promise<unknown> {
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
      'application/json'
  ) {
    await response.body?.cancel();
    throw new Error('TOKEN_ENDPOINT_REJECTED');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('TOKEN_ENDPOINT_INVALID');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new Error('TOKEN_ENDPOINT_INVALID');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

@Injectable()
export class CombosServiceIdentity {
  private readonly cache = new Map<ServiceScope, CachedToken>();
  private readonly pending = new Map<ServiceScope, Promise<string>>();

  constructor(private readonly verifier: ComboTokenVerifier) {}

  invalidate(scope: ServiceScope): void {
    this.cache.delete(scope);
  }

  async authorization(
    scope: ServiceScope,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const cached = this.cache.get(scope);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.cache.delete(scope);
    const existing = this.pending.get(scope);
    if (existing) return raceWithSignal(existing, signal);
    const pending = this.issue(scope).finally(() => {
      this.pending.delete(scope);
    });
    this.pending.set(scope, pending);
    return raceWithSignal(pending, signal);
  }

  private async issue(scope: ServiceScope): Promise<string> {
    const tokenUrl = process.env.COMBOS_G7_TOKEN_URL?.trim();
    const secret = process.env.COMBOS_G7_CLIENT_SECRET;
    if (!tokenUrl || !secret)
      throw new IntegrationFailure(
        scope === 'catalogo:leer' ? 'CATALOG' : 'PRICING',
        'AUTH_NOT_CONFIGURED',
      );
    let url: URL;
    try {
      url = new URL(tokenUrl);
    } catch {
      throw new IntegrationFailure(
        scope === 'catalogo:leer' ? 'CATALOG' : 'PRICING',
        'AUTH_NOT_CONFIGURED',
      );
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new IntegrationFailure(
        scope === 'catalogo:leer' ? 'CATALOG' : 'PRICING',
        'AUTH_NOT_CONFIGURED',
      );
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'modulo-productos',
          client_secret: secret,
          scope,
        }),
      });
      const payload = await readTokenBody(response);
      if (
        !record(payload) ||
        typeof payload.accessToken !== 'string' ||
        payload.tokenType !== 'Bearer' ||
        !Number.isSafeInteger(payload.expiresIn) ||
        Number(payload.expiresIn) < 1 ||
        !Array.isArray(payload.scopes) ||
        payload.scopes.length !== 1 ||
        payload.scopes[0] !== scope
      )
        throw new Error('TOKEN_RESPONSE_INVALID');
      const principal = await this.verifier.verify(payload.accessToken);
      if (
        principal.kind !== 'service' ||
        principal.subject !== 'modulo-productos' ||
        principal.audiences.length !== 1 ||
        principal.audiences[0] !== 'api-productos' ||
        principal.scopes.length !== 1 ||
        principal.scopes[0] !== scope
      )
        throw new Error('TOKEN_CLAIMS_INVALID');
      const claims: unknown = JSON.parse(
        Buffer.from(payload.accessToken.split('.')[1]!, 'base64url').toString(),
      );
      if (!record(claims) || typeof claims.exp !== 'number')
        throw new Error('TOKEN_EXPIRY_INVALID');
      const now = Date.now();
      const lifetime = Math.min(
        Number(payload.expiresIn) * 1000,
        claims.exp * 1000 - now,
      );
      if (!Number.isFinite(lifetime) || lifetime <= 0)
        throw new Error('TOKEN_EXPIRED');
      const expiresAt = now + lifetime - Math.min(30000, lifetime / 10);
      this.cache.set(scope, { value: payload.accessToken, expiresAt });
      return payload.accessToken;
    } catch {
      this.cache.delete(scope);
      throw new IntegrationFailure(
        scope === 'catalogo:leer' ? 'CATALOG' : 'PRICING',
        'AUTH_UNAVAILABLE',
      );
    }
  }
}

async function raceWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
