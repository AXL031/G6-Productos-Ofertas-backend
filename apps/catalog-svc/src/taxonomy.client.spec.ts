import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readTaxonomyConfig } from './taxonomy-config.js';
import { TaxonomyClient } from './taxonomy.client.js';

describe('Taxonomy HTTP boundary', () => {
  let server: Server;
  let status = 200;
  let body: object = {};
  let path = '';
  let authorization: string | undefined;
  let origin: string;
  let client: TaxonomyClient;
  beforeAll(async () => {
    server = createServer((request, response) => {
      path = request.url ?? '';
      authorization = request.headers.authorization;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    origin = 'http://127.0.0.1:' + address.port;
    client = new TaxonomyClient(
      readTaxonomyConfig({
        CATALOG_TAXONOMY_URL: origin,
      }),
    );
    vi.stubEnv('CATALOG_TAXONOMY_URL', 'http://127.0.0.1:1');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    status = 200;
    body = {};
  });
  it('fails closed without an injected origin even when process.env contains one', async () => {
    await expect(
      new TaxonomyClient(readTaxonomyConfig({})).brand('b'),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('keeps standalone tooling compatible using the same validated snapshot', async () => {
    vi.stubEnv('CATALOG_TAXONOMY_URL', origin);
    const standalone = new TaxonomyClient();
    vi.stubEnv('CATALOG_TAXONOMY_URL', 'malformed');
    body = { categories: [] };
    await expect(standalone.category('missing')).rejects.toMatchObject({
      status: 422,
    });
    expect(path).toBe('/api/v1/categorias');
    expect(() => new TaxonomyClient()).toThrow('CATALOG_TAXONOMY_URL');
  });
  it('projects the contractual brand, discarding administrative fields', async () => {
    body = {
      brands: [
        {
          marca_id: 'b',
          name: 'Brand fixture',
          status: 'ACTIVA',
          admin: 'private',
        },
      ],
    };
    expect(await client.brand('b')).toEqual({
      marca_id: 'b',
      name: 'Brand fixture',
      description: null,
      logo_url: null,
      country_code: null,
    });
    expect(path).toBe('/api/v1/marcas');
  });
  it('validates categories through their owner endpoint', async () => {
    body = {
      categories: [
        { categoria_id: 'c', name: 'Category fixture', status: 'ACTIVA' },
      ],
    };
    await client.category('c');
    expect(path).toBe('/api/v1/categorias');
    await expect(client.category('missing')).rejects.toMatchObject({
      status: 422,
    });
  });
  it('forwards verified service credentials and uses administrative routes for users', async () => {
    body = { brands: [{ marca_id: 'b', name: 'Brand', status: 'ACTIVA' }] };
    await client.brand('b', 'trace', {
      authorization: 'Bearer service-fixture',
      user: false,
    });
    expect(authorization).toBe('Bearer service-fixture');
    expect(path).toBe('/api/v1/marcas');
    body = {
      marcaId: 'b',
      nombre: 'Brand',
      estado: 'ACTIVO',
      version: 1,
      descripcion: 'Description',
      logoUrl: null,
      paisOrigenIso: 'PE',
    };
    expect(
      await client.brand('b', 'trace', {
        authorization: 'Bearer user-fixture',
        user: true,
      }),
    ).toEqual({
      marca_id: 'b',
      name: 'Brand',
      description: 'Description',
      logo_url: null,
      country_code: 'PE',
    });
    expect(authorization).toBe('Bearer user-fixture');
    expect(path).toBe('/api/v1/marcas/b');
    body = {
      categoriaId: 'c',
      nombre: 'Category',
      estado: 'ACTIVO',
      version: 1,
    };
    await client.category('c', 'trace', {
      authorization: 'Bearer user-fixture',
      user: true,
    });
    expect(path).toBe('/api/v1/categorias/c');
    status = 404;
    await expect(
      client.category('missing', 'trace', {
        authorization: 'Bearer user-fixture',
        user: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it('does not accept pending/inactive masters as active', async () => {
    for (const state of ['PENDING_DEACTIVATION', 'INACTIVA']) {
      body = {
        brands: [{ marca_id: 'b', name: 'Brand fixture', status: state }],
      };
      await expect(client.brand('b')).rejects.toMatchObject({ status: 503 });
    }
  });
  it('fails closed on missing/malformed/upstream errors without returning response details', async () => {
    body = { brands: [] };
    await expect(client.brand('missing')).rejects.toMatchObject({
      status: 422,
    });
    body = { brands: 'invalid' };
    await expect(client.brand('b')).rejects.toMatchObject({ status: 503 });
    status = 503;
    body = { password: 'fixture-private-error' };
    await expect(client.brand('b')).rejects.toMatchObject({
      status: 503,
      message: 'Servicio temporalmente no disponible',
    });
  });
});
