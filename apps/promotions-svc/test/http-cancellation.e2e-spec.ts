// Real HTTP sockets, native Nest guards/query/adapters and local RS256 JWT.
// Persistence, outbound credentials and commercial data are explicit fixtures.
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  createServer,
  request,
  type ClientRequest,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PromotionsSvcModule } from '../src/promotions-svc.module.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../src/infrastructure/config/promotions-config.js';
import { PromotionsPersistence } from '../src/infrastructure/persistence/promotions-persistence.js';
import { PROMOTIONS_SERVICE_TOKENS } from '../src/infrastructure/http/integration-providers.js';
import { PROMOTIONS_JWKS } from '../src/http/promotions-identity.js';
import { createEnvironmentFixture } from './support/environment.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('HTTP fixture observation timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Client disconnect cancels native outgoing HTTP', () => {
  const fixture = createEnvironmentFixture();
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'cancellation',
    alg: 'RS256',
    use: 'sig',
  };
  const issuer = 'https://cancellation.fixture/api/v1/auth';
  const ownToken = 'synthetic-own-service-token';
  const read = vi.fn(async (): Promise<unknown> => true);
  let app: INestApplication | undefined;
  let upstream: ReturnType<typeof createServer> | undefined;
  let caller: ClientRequest | undefined;
  let held: ServerResponse;
  let seen = deferred<void>(),
    closed = deferred<void>();
  let calls: string[] = [];
  let holdAt = '/contexto';
  let base = '';
  let closeAt = 0;
  const trace = randomUUID();

  const product = (id: string) => ({
    product_id: id,
    name: 'Fixture',
    slug: 'fixture',
    categoria_id: 'C',
    marca_id: 'M',
    tipo_producto_id: 'T',
    tiene_variantes: false,
    sku_base: id === 'ORIGIN' ? 'CANCEL-SKU' : 'REC-SKU',
    marca: { marca_id: 'M', name: 'M' },
    variants: [],
  });
  const context = {
    sku: 'CANCEL-SKU',
    productId: 'ORIGIN',
    isVariant: false,
    active: true,
    eligible: true,
  };
  const bearer = (scope: string) => {
    const now = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid: jwk.kid },
      {
        iss: issuer,
        sub: 'modulo-marketplace',
        tipo: 'servicio',
        aud: ['api-productos'],
        scope,
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
      },
    ].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'));
    return (
      parts.join('.') +
      '.' +
      sign(
        'RSA-SHA256',
        Buffer.from(parts.join('.')),
        pair.privateKey,
      ).toString('base64url')
    );
  };
  beforeEach(async () => {
    calls = [];
    seen = deferred<void>();
    closed = deferred<void>();
    closeAt = 0;
    read.mockReset();
    read.mockResolvedValue({ promotions: [], coupon: undefined });
    upstream = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer ' + ownToken);
      expect(req.headers['x-correlation-id']).toBe(trace);
      calls.push(url.pathname);
      if (url.pathname.includes(holdAt)) {
        held = res;
        res.once('close', () => {
          closeAt = performance.now();
          closed.resolve();
        });
        seen.resolve();
        return;
      }
      const id = url.pathname.split('/').at(-1)!;
      const data = url.pathname.endsWith('/contexto')
        ? context
        : url.pathname.includes('/inventario/')
          ? { items: [{ sku: 'REC-SKU', status: 'DISPONIBLE' }] }
          : url.pathname.includes('/precios/')
            ? {
                sku: id,
                precio_regular: 100,
                precio_oferta: 80,
                currency: 'PEN',
                channel_id: null,
                valid_from: '2026-01-01T00:00:00Z',
                valid_until: null,
                price_version: 1,
                vigencia_id: 'V',
                origen: 'PRODUCTO',
              }
            : product(id);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    const origin = `http://127.0.0.1:${address.port}`;
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useValue(
        new PromotionsConfigService({
          ...validatePromotionsConfiguration(fixture.environment),
          localDemoEnabled: false,
          auth: { issuer, jwksUrl: issuer + '/jwks' },
          upstreams: {
            catalog: origin,
            pricing: origin,
            inventory: origin,
            taxonomy: origin,
          },
        }),
      )
      .overrideProvider(PROMOTIONS_JWKS)
      .useValue(async () => [jwk])
      .overrideProvider(PROMOTIONS_SERVICE_TOKENS)
      .useValue(async (_operation: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        return ownToken;
      })
      .overrideProvider(PromotionsPersistence)
      .useValue({ read })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterEach(async () => {
    caller?.destroy();
    caller = undefined;
    upstream?.closeAllConnections();
    if (upstream)
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    await app?.close();
    app = undefined;
  });
  afterAll(() => fixture.cleanup());

  function open(path: string, scope: string, body?: object) {
    const response = deferred<{ status: number; body: unknown }>();
    caller = request(
      base + path,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer ' + bearer(scope),
          'content-type': 'application/json',
          'x-correlation-id': trace,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += String(chunk);
        });
        res.on('end', () =>
          response.resolve({ status: res.statusCode!, body: JSON.parse(text) }),
        );
      },
    );
    caller.on('error', (error) =>
      response.resolve({ status: 0, body: error.message }),
    );
    caller.end(body ? JSON.stringify(body) : undefined);
    return response.promise;
  }
  const basket = {
    channel_id: 'MARKETPLACE',
    lines: [{ sku: 'CANCEL-SKU', quantity: 1 }],
  };
  it.each([
    [
      'evaluate-context',
      '/api/v1/promociones/evaluar',
      'promociones:evaluar',
      '/contexto',
    ],
    [
      'coupon-context',
      '/api/v1/cupones/validar',
      'cupones:validar',
      '/contexto',
    ],
    [
      'recommend-origin',
      '/api/v1/recomendaciones?productoId=ORIGIN&canal=MARKETPLACE',
      'recomendaciones:leer',
      '/productos/ORIGIN',
    ],
    [
      'recommend-candidates',
      '/api/v1/recomendaciones?productoId=ORIGIN&canal=MARKETPLACE',
      'recomendaciones:leer',
      '/productos/REC',
    ],
    [
      'recommend-inventory',
      '/api/v1/recomendaciones?productoId=ORIGIN&canal=MARKETPLACE',
      'recomendaciones:leer',
      '/inventario/',
    ],
    [
      'recommend-price',
      '/api/v1/recomendaciones?productoId=ORIGIN&canal=MARKETPLACE',
      'recomendaciones:leer',
      '/precios/',
    ],
  ])(
    'closes the upstream socket on client disconnect: %s',
    async (_case, path, scope, stage) => {
      holdAt = stage;
      const recommendation = scope === 'recomendaciones:leer';
      if (recommendation)
        read.mockResolvedValueOnce(true).mockResolvedValueOnce([
          {
            id: randomUUID(),
            recommendationType: 'CROSS_SELL',
            priority: 1,
            items: [{ productId: 'REC', itemOrder: 1 }],
          },
        ]);
      const startedAt = performance.now();
      open(
        path,
        scope,
        recommendation ? undefined : { ...basket, coupon_code: 'FIXTURE' },
      );
      await within(seen.promise, 2000);
      expect(caller!.writableFinished).toBe(true);
      const count = calls.length;
      const disconnectedAt = performance.now();
      caller!.destroy();
      await within(closed.promise, 1500);
      expect(closeAt - disconnectedAt).toBeLessThan(1500); // Internal timeout is 2500 ms.
      expect(closeAt - startedAt).toBeLessThan(2000); // Cannot pass by waiting for the internal deadline.
      expect(held.writableEnded).toBe(false);
      await delay(30);
      expect(calls).toHaveLength(count); // No queued follow-up read or retry.
      if (!recommendation) expect(read).not.toHaveBeenCalled();
    },
  );
  it('keeps an ordinary completed POST alive and returns its result', async () => {
    holdAt = '/contexto';
    const response = open(
      '/api/v1/promociones/evaluar',
      'promociones:evaluar',
      basket,
    );
    await within(seen.promise, 2000);
    await delay(75);
    expect(closeAt).toBe(0);
    held.setHeader('Content-Type', 'application/json');
    held.end(JSON.stringify(context));
    expect(await within(response, 2000)).toMatchObject({
      status: 200,
      body: { result_amount: 80, promotion_id: null },
    });
  });
  it('still times out a hanging upstream while the client remains connected', async () => {
    holdAt = '/contexto';
    const started = performance.now();
    const response = open(
      '/api/v1/promociones/evaluar',
      'promociones:evaluar',
      basket,
    );
    await within(seen.promise, 2000);
    expect(await within(response, 4000)).toMatchObject({
      status: 503,
      body: { code: 'SERVICIO_NO_DISPONIBLE', correlationId: trace },
    });
    await within(closed.promise, 1500);
    expect(closeAt - started).toBeGreaterThanOrEqual(2400);
    expect(read).not.toHaveBeenCalled();
  });
});
