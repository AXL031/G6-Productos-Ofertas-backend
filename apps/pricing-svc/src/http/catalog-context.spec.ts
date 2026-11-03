import { createServer, type Server } from 'node:http';
import { CatalogContextHttp } from './catalog-context.js';
import { validateEnvironment } from '../config/environment.js';

describe('Pricing -> Catalog: contrato HTTP privado', () => {
  let server: Server;
  let origin: string;
  let status = 200;
  let type = 'application/json';
  let body: unknown;
  let raw: string | undefined;
  let delay = 0;
  let received: { url?: string; authorization?: string }[];
  const sku = '0001 /á,?';
  const config = () => ({
    nodeEnv: 'test' as const,
    port: 3002,
    databaseUrl: 'unused',
    databaseSsl: false as const,
    catalogUrl: origin,
  });
  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push({ url: req.url, authorization: req.headers.authorization });
      const respond = () => {
        res.writeHead(status, {
          'content-type': type,
          location: origin + '/redirect',
        });
        res.end(raw ?? JSON.stringify(body));
      };
      if (delay) setTimeout(respond, delay);
      else respond();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture HTTP sin puerto');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    status = 200;
    type = 'application/json';
    raw = undefined;
    delay = 0;
    received = [];
    body = {
      sku,
      productId: 'product',
      isVariant: false,
      active: true,
      eligible: true,
    };
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it.each([false, true])(
    'conserva SKU opaco y variante=%s con credencial propia',
    async (isVariant) => {
      body = {
        sku,
        productId: 'product',
        isVariant,
        active: true,
        eligible: true,
      };
      expect(
        await new CatalogContextHttp(
          config(),
          async () => 'fixture-service-token',
        ).resolve(sku),
      ).toEqual(body);
      expect(received).toEqual([
        {
          url: `/api/v1/productos/skus/${encodeURIComponent(sku)}/contexto`,
          authorization: 'Bearer fixture-service-token',
        },
      ]);
    },
  );
  it.each([
    [false, false],
    [true, false],
  ])('conserva flags active=%s eligible=%s', async (active, eligible) => {
    body = { sku, productId: 'product', isVariant: true, active, eligible };
    expect(
      await new CatalogContextHttp({
        ...config(),
        demoNoAuthEnabled: true,
      }).resolve(sku),
    ).toEqual(body);
    expect(received[0].authorization).toBeUndefined();
  });
  it('solo traduce el 404 contractual a null', async () => {
    status = 404;
    type = 'application/problem+json';
    body = { status: 404, code: 'SKU_NO_ENCONTRADO' };
    expect(
      await new CatalogContextHttp({
        ...config(),
        demoNoAuthEnabled: true,
      }).resolve(sku),
    ).toBeNull();
  });
  it.each([401, 403, 404, 503, 302])(
    'no oculta HTTP %s como ausencia',
    async (code) => {
      status = code;
      type = 'application/problem+json';
      body = { status: code, code: 'OTHER' };
      await expect(
        new CatalogContextHttp({
          ...config(),
          demoNoAuthEnabled: true,
        }).resolve(sku),
      ).rejects.toMatchObject({ status: 503 });
      expect(received).toHaveLength(1);
    },
  );
  it.each([
    'invalid-json',
    'large',
    'wrong-sku',
    'missing-field',
    'wrong-type',
  ])('rechaza DTO %s', async (invalid) => {
    if (invalid === 'invalid-json') raw = '{';
    if (invalid === 'large') raw = ' '.repeat(65537);
    if (invalid === 'wrong-sku') body = { sku: 'other' };
    if (invalid === 'missing-field') body = { sku, productId: 'product' };
    if (invalid === 'wrong-type') type = 'text/plain';
    await expect(
      new CatalogContextHttp({ ...config(), demoNoAuthEnabled: true }).resolve(
        sku,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('falla cerrado sin URL o token, sin llamadas HTTP', async () => {
    for (const client of [
      new CatalogContextHttp(config()),
      new CatalogContextHttp({ ...config(), catalogUrl: undefined }),
    ]) {
      await expect(client.resolve(sku)).rejects.toMatchObject({ status: 503 });
    }
    expect(received).toEqual([]);
  });
  it('limita el tiempo de respuesta HTTP', async () => {
    delay = 2200;
    await expect(
      new CatalogContextHttp({ ...config(), demoNoAuthEnabled: true }).resolve(
        sku,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('valida el origen configurado y permite solo HTTP privado demo o loopback test', () => {
    const env = {
      NODE_ENV: 'test',
      PORT: '3002',
      DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
    };
    expect(
      validateEnvironment({ ...env, PRICING_CATALOG_URL: origin }).catalogUrl,
    ).toBe(origin);
    expect(
      validateEnvironment({
        ...env,
        NODE_ENV: 'development',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        PRICING_CATALOG_URL: 'http://catalog-svc:3001',
      }).catalogUrl,
    ).toBe('http://catalog-svc:3001');
    for (const url of [
      'http://public.example',
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com/?query=1',
      'https://example.com/#hash',
    ]) {
      expect(() =>
        validateEnvironment({ ...env, PRICING_CATALOG_URL: url }),
      ).toThrow();
    }
  });
});
