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
  const identity = {
    authorization: vi.fn(async () => 'Bearer taxonomy-service-fixture'),
  };
  const client = new CatalogMasterClient(
    { origin: 'http://127.0.0.1:9876' } as never,
    identity,
  );
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
          authorization: 'Bearer taxonomy-service-fixture',
          'x-correlation-id': correlation,
        }),
      }),
    );
    await expect(
      client.attributes(
        'type',
        [{ ...value, valor: null }],
        true,
        authorization,
        correlation,
      ),
    ).resolves.toEqual([
      { ...value, valor: null, nombre: 'Authoritative Size' },
    ]);
  });
  it('uses M2M for protected technical reads from restricted demo without forwarding an incoming token', async () => {
    identity.authorization.mockClear();
    const authorizations: (string | null)[] = [];
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      authorizations.push(new Headers(init.headers).get('authorization'));
      const path = String(_url);
      const value = path.includes('/categorias/')
        ? {
            categoriaId: 'cat',
            nombre: 'Category',
            estado: 'ACTIVO',
            version: 1,
          }
        : path.includes('/marcas/')
          ? {
              marcaId: 'brand',
              nombre: 'Brand',
              estado: 'ACTIVO',
              version: 1,
            }
          : {
              tipoProductoId: 'type',
              nombre: 'Type',
              estado: 'ACTIVO',
              schemaVersion: 1,
            };
      return new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(
      client.masters(
        { categoria_id: 'cat', marca_id: 'brand', tipo_producto_id: 'type' },
        '',
        correlation,
      ),
    ).resolves.toEqual({ schemaVersion: 1 });
    expect(identity.authorization).toHaveBeenCalledOnce();
    expect(authorizations).toEqual([
      'Bearer taxonomy-service-fixture',
      'Bearer taxonomy-service-fixture',
      'Bearer taxonomy-service-fixture',
    ]);
  });
  it('fails safely when restricted demo needs a protected read but M2M credentials are absent', async () => {
    const noIdentity = new CatalogMasterClient({
      origin: 'http://127.0.0.1:9876',
    } as never);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      noIdentity.masters(
        { categoria_id: 'cat', marca_id: 'brand', tipo_producto_id: 'type' },
        '',
        correlation,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
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
  it.each([500, 503])(
    'maps upstream HTTP %i to a sanitized dependency failure',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response('untrusted stack trace', {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      );
      await expect(
        client.masters(
          { categoria_id: 'cat', marca_id: 'brand', tipo_producto_id: 'type' },
          authorization,
          correlation,
        ),
      ).rejects.toMatchObject({ status: 503 });
      const error = await client
        .masters(
          { categoria_id: 'cat', marca_id: 'brand', tipo_producto_id: 'type' },
          authorization,
          correlation,
        )
        .catch((failure: unknown) => failure);
      expect(error).not.toHaveProperty('response.stack');
      expect(error).not.toHaveProperty('response.body');
    },
  );
  it.each([
    [400, 400, 'VALIDACION'],
    [422, 422, 'CATEGORIA_INVALIDA'],
  ])(
    'maps remote HTTP %i to Catalog %i %s without forwarding bodies',
    async (remoteStatus, status, code) => {
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response('private provider detail', {
            status: remoteStatus,
            headers: { 'content-type': 'text/plain' },
          }),
      );
      await expect(
        client.masters(
          { categoria_id: 'cat', marca_id: 'brand', tipo_producto_id: 'type' },
          authorization,
          correlation,
        ),
      ).rejects.toMatchObject({
        status,
        response: { code },
      });
    },
  );
  it.each([
    ['timeout', async () => Promise.reject(new Error('secret timeout'))],
    [
      'invalid JSON',
      async () =>
        new Response('{broken', {
          headers: { 'content-type': 'application/json' },
        }),
    ],
  ])('maps a Taxonomy %s to a sanitized 503', async (_name, fetcher) => {
    vi.stubGlobal('fetch', fetcher);
    await expect(
      client.masters(
        { categoria_id: 'cat', marca_id: 'brand', tipo_producto_id: 'type' },
        authorization,
        correlation,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('maps a missing characteristic to its contractual validation code', async () => {
    vi.stubGlobal('fetch', async (url: URL) =>
      url.pathname.endsWith('/caracteristicas/size')
        ? new Response('{}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(
            JSON.stringify({
              ...schema,
              caracteristicas: [
                {
                  ...schema.caracteristicas[0],
                  caracteristica: undefined,
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
    );
    await expect(
      client.attributes('type', [value], false, authorization, correlation),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'ATRIBUTO_IDENTIFICADOR_INVALIDO' },
    });
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
