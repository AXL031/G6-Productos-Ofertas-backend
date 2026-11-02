import type { PromotionsConfigService } from '../config/promotions-config.js';
import type { PromotionsIdentity } from '../../http/promotions-identity.js';
import { object } from '../../http/http-validation.js';
import { withDeadline } from '../resilience/deadline.js';
import {
  internalOperations,
  type ServiceAccessTokenSource,
} from './internal-http.js';

interface TokenFlight {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
  settled: boolean;
}

// G7 emitirTokenServicio / TokenServicio; G6 INT-01/04. Credentials identify
// modulo-productos and never come from a browser bearer. No grant is inferred.
export function promotionsServiceTokens(
  config: PromotionsConfigService,
  identity: PromotionsIdentity,
): ServiceAccessTokenSource {
  const cache = new Map<string, { token: string; until: number }>();
  const pending = new Map<string, TokenFlight>();
  const issue = (
    scope: string,
    credentials: NonNullable<
      PromotionsConfigService['settings']['serviceCredentials']
    >,
    controller: AbortController,
  ) =>
    withDeadline(async (deadline) => {
      const signal = AbortSignal.any([controller.signal, deadline]);
      const response = await fetch(credentials.tokenUrl, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'modulo-productos',
          client_secret: credentials.clientSecret,
          scope,
        }).toString(),
      });
      if (
        response.status !== 200 ||
        !response.body ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const body: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        !object(body) ||
        typeof body.accessToken !== 'string' ||
        body.tokenType !== 'Bearer' ||
        !Number.isSafeInteger(body.expiresIn) ||
        (body.expiresIn as number) <= 0 ||
        !Array.isArray(body.scopes) ||
        !body.scopes.every((s) => typeof s === 'string') ||
        !body.scopes.includes(scope)
      )
        throw new Error();
      await identity.authorize(
        {
          security: ['serviceBearer'],
          audience: 'api-productos',
          clients: ['modulo-productos'],
          scope,
        },
        'Bearer ' + body.accessToken,
      );
      // Only inspect lifetime/scopes after cryptographic verification above.
      const claims: unknown = JSON.parse(
        Buffer.from(body.accessToken.split('.')[1], 'base64url').toString(
          'utf8',
        ),
      );
      if (
        !object(claims) ||
        typeof claims.exp !== 'number' ||
        typeof claims.scope !== 'string'
      )
        throw new Error();
      const granted = new Set(claims.scope.split(' ').filter(Boolean));
      if (
        granted.size !== body.scopes.length ||
        !body.scopes.every((s) => granted.has(s))
      )
        throw new Error();
      const lifetime = Math.min(
        (body.expiresIn as number) * 1000,
        claims.exp * 1000 - Date.now(),
      );
      if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error();
      signal.throwIfAborted();
      cache.set(scope, {
        token: body.accessToken,
        until: Date.now() + lifetime - Math.min(30000, lifetime / 10),
      });
      return body.accessToken;
    }, 1000);
  return async (request, callerSignal) => {
    try {
      callerSignal.throwIfAborted();
      const operation = Object.hasOwn(internalOperations, request.operationId)
        ? internalOperations[request.operationId]
        : undefined;
      if (
        request.audience !== 'api-productos' ||
        !operation ||
        operation.scope !== request.scope
      )
        throw new Error();
      const scope = operation.scope;
      const credentials = config.settings.serviceCredentials;
      if (!credentials || config.settings.localDemoEnabled) return null;
      const cached = cache.get(scope);
      if (cached && cached.until > Date.now()) return cached.token;
      let flight = pending.get(scope);
      if (!flight) {
        const controller = new AbortController();
        flight = {
          controller,
          waiters: 0,
          settled: false,
          promise: issue(scope, credentials, controller),
        };
        pending.set(scope, flight);
        const current = flight;
        const finish = () => {
          current.settled = true;
          if (pending.get(scope) === current) pending.delete(scope);
        };
        // Both branches handle settlement; no detached rejecting promise.
        void current.promise.then(finish, finish);
      }
      const current = flight;
      current.waiters++;
      let abort!: () => void;
      try {
        const token = await Promise.race([
          current.promise,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('TOKEN_WAITER_CANCELLED'));
            callerSignal.addEventListener('abort', abort, { once: true });
            if (callerSignal.aborted) abort();
          }),
        ]);
        callerSignal.throwIfAborted();
        return token;
      } finally {
        callerSignal.removeEventListener('abort', abort);
        current.waiters--;
        // A caller owns its wait, not other callers' transport. Last cancellation
        // removes the flight immediately so a retry need not join aborted work.
        if (!current.settled && current.waiters === 0) {
          if (pending.get(scope) === current) pending.delete(scope);
          current.controller.abort();
        }
      }
    } catch {
      throw new Error('PROMOTIONS_SERVICE_TOKEN_UNAVAILABLE');
    }
  };
}
