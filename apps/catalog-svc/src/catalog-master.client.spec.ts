import { CatalogMasterClient } from './catalog-master.client.js';

describe('Authoritative catalog master validation', () => {
  const authorization = 'Bearer isolated-user-token',
    correlation = '00000000-0000-4000-8000-000000000001';
  const value = {
    caracteristica_id: 'size',
    nombre: 'untrusted snapshot',
    valor_id: 'M',
    valor: 'M',
  };
  const schema = {
    tipoProducto: {
      tipoProductoId: 'type',
      nombre: 'Type',
      estado: 'ACTIVO',
      schemaVersion: 1,
    },
    schemaVersion: 1,
    caracteristicas: [
      {
        caracteristicaId: 'size',
        obligatoria: true,
        estado: 'ACTIVO',
        schemaVersion: 1,
        caracteristica: {
          caracteristicaId: 'size',
          nombre: 'Authoritative Size',
          tipo: 'LISTA',
          estado: 'ACTIVO',
          version: 1,
          valores: [
            { valorId: 'M', nombre: 'Medium', estado: 'ACTIVO', version: 1 },
          ],
        },
      },
    ],
  };
  const client = new CatalogMasterClient({
    origin: 'http://127.0.0.1:9876',
  } as never);
  afterEach(() => vi.unstubAllGlobals());
  it('uses published schema fields, validates enum values and takes names from Taxonomy', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(schema), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await client.attributes(
        'type',
        [value],
        true,
        authorization,
        correlation,
      ),
    ).toEqual([{ ...value, nombre: 'Authoritative Size' }]);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization,
          'x-correlation-id': correlation,
        }),
      }),
    );
  });
  it('does not infer validity or use fallback data after a dependency failure', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('{}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      client.attributes('type', [value], true, authorization, correlation),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('rejects an effective schema that changed between type and attribute validation', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(schema), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      client.attributes('type', [value], false, authorization, correlation, 2),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      client.attributes('type', [value], false, authorization, correlation, 1),
    ).resolves.toMatchObject([{ nombre: 'Authoritative Size' }]);
  });
  it('requires mandatory attributes only for activation and rejects unknown LISTA values', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(schema), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      client.attributes('type', [], true, authorization, correlation),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'DATOS_INCOMPLETOS' },
    });
    await expect(
      client.attributes('type', [], false, authorization, correlation),
    ).resolves.toEqual([]);
    await expect(
      client.attributes(
        'type',
        [{ ...value, valor_id: 'UNKNOWN' }],
        false,
        authorization,
        correlation,
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'ATRIBUTO_IDENTIFICADOR_INVALIDO' },
    });
  });
  it('rejects unavailable or inactive authoritative product types', async () => {
    vi.stubGlobal(
      'fetch',
      async (url: URL) =>
        new Response(
          JSON.stringify(
            url.pathname.includes('/categorias/')
              ? {
                  categoriaId: 'cat',
                  nombre: 'Category',
                  estado: 'ACTIVO',
                  version: 1,
                }
              : url.pathname.includes('/marcas/')
                ? {
                    marcaId: 'brand',
                    nombre: 'Brand',
                    estado: 'ACTIVO',
                    version: 1,
                  }
                : {
                    tipoProductoId: 'type',
                    estado: 'INACTIVO',
                    schemaVersion: 1,
                  },
          ),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      client.masters(
        { categoria_id: 'cat', marca_id: 'brand', tipo_producto_id: 'type' },
        authorization,
        correlation,
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'TIPO_PRODUCTO_INVALIDO' },
    });
  });
});
