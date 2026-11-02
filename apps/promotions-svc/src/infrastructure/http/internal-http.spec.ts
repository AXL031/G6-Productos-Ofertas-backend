import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { InternalHttpReader, internalOrigin } from './internal-http.js';

// Synthetic token and HTTP peers only; no G7 grant or deployed provider is asserted.
async function fixture(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  work: (origin: string) => Promise<void>,
) {
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  try {
    await work('http://127.0.0.1:' + address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('Internal HTTP credential boundary (PR143)', () => {
  it.each([
    'http://example.org',
    'http://10.0.0.7:3001',
    'http://catalog-svc.example.org:3001',
    'http://pricing-svc:3002',
    'https://user:password@example.org',
    'https://example.org/path',
  ])(
    'rejects unapproved catalog origin %s before acquiring credentials',
    (origin) => {
      const tokens = vi.fn();
      expect(
        () =>
          new InternalHttpReader({
            origin,
            origins: { catalog: origin },
            getServiceAccessToken: tokens,
          }),
      ).toThrow('INVALID_COMMERCIAL_ORIGIN');
      expect(tokens).not.toHaveBeenCalled();
    },
  );

  it('permits TLS and exact service aliases by configuration, without claiming network verification', () => {
    expect(
      internalOrigin('https://catalog.example.org', false, 'catalog'),
    ).toBe('https://catalog.example.org');
    expect(internalOrigin('http://catalog-svc:3001', false, 'catalog')).toBe(
      'http://catalog-svc:3001',
    );
    expect(internalOrigin('http://127.0.0.1:3001', false)).toBe(
      'http://127.0.0.1:3001',
    );
  });

  it('defaults to authenticated access and requests only its own per-operation token', async () => {
    let calls = 0;
    await fixture(
      (req, res) => {
        calls++;
        expect(req.headers.authorization).toBe(
          'Bearer synthetic-own-service-token',
        );
        expect(req.headers.cookie).toBeUndefined();
        expect(req.headers['x-user-role']).toBeUndefined();
        expect(req.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/i);
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"fixture":true}');
      },
      async (origin) => {
        const tokens = vi.fn(async () => 'synthetic-own-service-token');
        const reader = new InternalHttpReader({
          origin,
          getServiceAccessToken: tokens,
        });
        await expect(
          reader.read(
            'obtenerProducto',
            '/productos/P',
            AbortSignal.timeout(2500),
          ),
        ).resolves.toEqual({ fixture: true });
        expect(tokens).toHaveBeenCalledWith(
          {
            operationId: 'obtenerProducto',
            audience: 'api-productos',
            scope: 'catalogo:leer',
          },
          expect.any(AbortSignal),
        );
      },
    );
    expect(calls).toBe(1);
  });

  it('does not fall back to an anonymous request when its token is unavailable', async () => {
    let calls = 0;
    await fixture(
      (_req, res) => {
        calls++;
        res.end();
      },
      async (origin) => {
        const reader = new InternalHttpReader({
          origin,
          getServiceAccessToken: async () => null,
        });
        await expect(
          reader.read(
            'obtenerProducto',
            '/productos/P',
            AbortSignal.timeout(2500),
          ),
        ).rejects.toThrow('COMMERCIAL_SESSION_UNAVAILABLE');
      },
    );
    expect(calls).toBe(0);
  });

  it('never sends the bearer to a redirect target', async () => {
    let targetCalls = 0;
    await fixture(
      (_req, res) => {
        targetCalls++;
        res.end();
      },
      async (target) => {
        await fixture(
          (_req, res) => {
            res.writeHead(302, { location: target + '/unexpected' }).end();
          },
          async (origin) => {
            const reader = new InternalHttpReader({
              origin,
              getServiceAccessToken: async () => 'synthetic-own-service-token',
            });
            await expect(
              reader.read(
                'obtenerProducto',
                '/productos/P',
                AbortSignal.timeout(2500),
              ),
            ).rejects.toThrow();
          },
        );
      },
    );
    expect(targetCalls).toBe(0);
  });

  it('does not acquire or send a token in explicit restricted demo', async () => {
    await fixture(
      (req, res) => {
        expect(req.headers.authorization).toBeUndefined();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      },
      async (origin) => {
        const tokens = vi.fn();
        const reader = new InternalHttpReader({
          origin,
          mode: 'RESTRICTED_DEMO',
          getServiceAccessToken: tokens,
        });
        await reader.read(
          'obtenerProducto',
          '/productos/P',
          AbortSignal.timeout(2500),
        );
        expect(tokens).not.toHaveBeenCalled();
      },
    );
  });
});
