import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpCommercialContext } from './commercial-http.js';

// Latency fixture, not a substitute for provider integration evidence.
describe('Recommendation HTTP latency with multiple variants', () => {
  it('resolves six products with four variants each within the existing 2500 ms deadline', async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const instants = new Set<string>();
    const server = createServer(async (request, response) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      calls++;
      try {
        const url = new URL(request.url!, 'http://fixture.invalid');
        expect(request.headers.authorization).toBeUndefined();
        expect(url.searchParams.get('canal')).toBe('MARKETPLACE');
        await delay(100);
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const body = url.pathname.includes('/productos/')
          ? {
              product_id: id,
              name: id,
              slug: id,
              tipo_producto_id: 'TYPE',
              marca_id: 'BRAND',
              marca: { marca_id: 'BRAND', name: 'Fixture' },
              categoria_id: 'CATEGORY',
              tiene_variantes: true,
              variants: [0, 1, 2, 3].map((i) => ({
                variant_id: id + '-' + i,
                sku: id + '-' + i,
              })),
            }
          : url.pathname.includes('/precios/')
            ? {
                sku: id,
                precio_regular: 100,
                precio_oferta: 80 - Number(id.at(-1)),
                currency: 'PEN',
                channel_id: 'MARKETPLACE',
                valid_from: '2026-01-01T00:00:00Z',
                valid_until: null,
                price_version: 1,
                vigencia_id: 'FIXTURE',
                origen: 'SKU_OVERRIDE',
              }
            : {
                items: url.searchParams
                  .get('skus')!
                  .split(',')
                  .map((sku) => ({
                    sku,
                    status: 'DISPONIBLE',
                  })),
              };
        if (url.pathname.includes('/precios/'))
          instants.add(url.searchParams.get('at')!);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      } finally {
        inFlight--;
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing port');
    const client = new HttpCommercialContext({
      origin: 'http://127.0.0.1:' + address.port,
      mode: 'RESTRICTED_DEMO',
    });
    const started = performance.now();
    try {
      const ids = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
      const result = await client.recommendationProducts(ids, 'MARKETPLACE');
      const elapsed = performance.now() - started;
      expect([...result.keys()]).toEqual(ids);
      expect([...result.values()]).toEqual(
        ids.map(() => ({
          active: true,
          channelEligible: true,
          availability: 'DISPONIBLE',
          currentPrice: 77,
        })),
      );
      expect(elapsed).toBeLessThan(2500);
      expect(calls).toBe(31);
      expect(instants.size).toBe(1);
      expect(peak).toBeLessThanOrEqual(4);
      console.info(
        JSON.stringify({
          scenario: '6x4, 100ms per HTTP call',
          elapsed,
          calls,
          peak,
        }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
