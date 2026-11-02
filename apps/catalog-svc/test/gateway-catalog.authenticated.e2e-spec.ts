import { CatalogGatewayHarness } from './support/catalog-gateway-harness.js';

const product = '00000000-0000-4000-8000-000000000050';
const variant = '00000000-0000-4000-8000-000000000051';
const administrativeOperations = [
  ['listarProductos', 'GET', '/productos'],
  ['obtenerProducto', 'GET', `/productos/${product}`],
  ['obtenerProductoPorSlug', 'GET', '/productos/por-slug/fixture'],
  ['crearProducto', 'POST', '/productos'],
  ['actualizarProducto', 'PATCH', `/productos/${product}`],
  ['activarProducto', 'POST', `/productos/${product}/activar`],
  ['desactivarProducto', 'POST', `/productos/${product}/desactivar`],
  ['reactivarProducto', 'POST', `/productos/${product}/reactivar`],
  ['obtenerPreparacionProducto', 'GET', `/productos/${product}/preparacion`],
  [
    'reintentarPreparacionProducto',
    'POST',
    `/productos/${product}/preparacion/reintentar`,
  ],
  ['listarVariantesProducto', 'GET', `/productos/${product}/variantes`],
  ['obtenerVariante', 'GET', `/productos/${product}/variantes/${variant}`],
  ['crearVariante', 'POST', `/productos/${product}/variantes`],
  ['actualizarVariante', 'PATCH', `/productos/${product}/variantes/${variant}`],
  [
    'activarVariante',
    'POST',
    `/productos/${product}/variantes/${variant}/activar`,
  ],
  [
    'desactivarVariante',
    'POST',
    `/productos/${product}/variantes/${variant}/desactivar`,
  ],
  [
    'reactivarVariante',
    'POST',
    `/productos/${product}/variantes/${variant}/reactivar`,
  ],
  [
    'reintentarPreparacionVariante',
    'POST',
    `/productos/${product}/variantes/${variant}/preparacion/reintentar`,
  ],
] as const;

describe('Issue #50 authenticated real Gateway → real Catalog (cryptographic fixtures; no DB)', () => {
  const harness = new CatalogGatewayHarness();
  beforeAll(() => harness.start(), 90000);
  afterAll(() => harness.close(), 15000);

  it.each(administrativeOperations)(
    'protects %s on Gateway and Catalog',
    async (_id, method, path) => {
      for (const direct of [false, true]) {
        const absent = await harness.call(
          method,
          path,
          undefined,
          null,
          direct,
        );
        expect(absent.status).toBe(401);
        expect(absent.body).toMatchObject({
          code: 'TOKEN_INVALIDO',
          correlationId: harness.correlation,
        });
        const wrongRole = await harness.call(
          method,
          path,
          undefined,
          harness.token({ roles: ['CLIENTE'] }),
          direct,
        );
        expect(wrongRole.status).toBe(403);
        expect(wrongRole.body.code).toBe('SCOPE_INSUFICIENTE');
        const wrongActor = harness.token({
          tipo: 'servicio',
          sub: 'modulo-marketplace',
          aud: 'api-productos',
          scope: 'catalogo:leer',
          roles: undefined,
        });
        if (
          ![
            'listarProductos',
            'obtenerProducto',
            'obtenerProductoPorSlug',
          ].includes(_id)
        ) {
          const denied = await harness.call(
            method,
            path,
            undefined,
            wrongActor,
            direct,
          );
          expect(denied.status).toBe(403);
          expect(denied.body.code).toBe('SCOPE_INSUFICIENTE');
        }
      }
    },
  );

  it.each([
    ['malformed', (): string => 'invalid.jwt.fixture'],
    ['signature', (): string => harness.token({}, true)],
    ['expired', (): string => harness.token({ exp: 1 })],
    [
      'issuer',
      (): string => harness.token({ iss: 'https://wrong-issuer.invalid' }),
    ],
  ] as const)('rejects %s JWT on both real verifiers', async (_case, token) => {
    for (const direct of [false, true]) {
      const result = await harness.call(
        'POST',
        '/productos',
        {},
        token(),
        direct,
      );
      expect(result.status).toBe(401);
      expect(result.body.code).toBe('TOKEN_INVALIDO');
    }
  });

  it('keeps human role checks and service channel/scope/allowlist checks', async () => {
    const role = harness.token({ roles: ['CLIENTE'] });
    for (const direct of [false, true])
      expect(
        (await harness.call('POST', '/productos', {}, role, direct)).status,
      ).toBe(403);
    const service = {
      tipo: 'servicio',
      sub: 'modulo-marketplace',
      aud: 'api-productos',
      scope: 'catalogo:leer',
      roles: undefined,
    };
    for (const direct of [false, true]) {
      const rejected = await harness.call(
        'GET',
        '/productos?canal=MARKETPLACE',
        undefined,
        harness.token({ ...service, aud: 'another-api' }),
        direct,
      );
      expect(rejected.status).toBe(401);
      expect(rejected.body.code).toBe('TOKEN_INVALIDO');
    }
    expect(
      (
        await harness.call(
          'GET',
          '/productos',
          undefined,
          harness.token(service),
        )
      ).status,
    ).toBe(400);
    for (const claims of [
      { ...service, scope: 'precios:leer' },
      { ...service, sub: 'modulo-despacho' },
    ])
      expect(
        (
          await harness.call(
            'GET',
            '/productos?canal=MARKETPLACE',
            undefined,
            harness.token(claims),
          )
        ).status,
      ).toBe(403);
  });

  it.each([
    ['POST', '/productos', {}, 400, 'VALIDACION'],
    [
      'POST',
      `/productos/${product}/variantes`,
      { sku: null },
      422,
      'SKU_INVALIDO',
    ],
    [
      'PATCH',
      `/productos/${product}`,
      { skuBase: 'changed' },
      409,
      'CAMBIO_ESTRUCTURAL_NO_PERMITIDO',
    ],
    [
      'PATCH',
      `/productos/${product}/variantes/${variant}`,
      { sku: 'changed' },
      409,
      'CAMBIO_ESTRUCTURAL_NO_PERMITIDO',
    ],
    ['GET', '/productos?pagina=0', undefined, 400, 'VALIDACION'],
  ] as const)(
    'preserves business/input error %s %s',
    async (method, path, body, status, code) => {
      const result = await harness.call(method, path, body);
      expect(result.status).toBe(status);
      expect(result.type).toContain('application/problem+json');
      expect(result.correlation).toBe(harness.correlation);
      expect(result.body).toMatchObject({
        code,
        correlationId: harness.correlation,
      });
    },
  );

  it.each([
    `/productos/${product}/variantes?pagina=1&pagina=2`,
    `/productos/${product}/variantes/not-a-uuid`,
  ])(
    'records the Gateway route defect: variant read 400 VALIDACION is not admitted at %s',
    async (path) => {
      const direct = await harness.call(
        'GET',
        path,
        undefined,
        harness.token(),
        true,
      );
      expect(direct.status).toBe(400);
      expect(direct.body.code).toBe('VALIDACION');
      const proxied = await harness.call('GET', path);
      expect(proxied.status).toBe(503);
      expect(proxied.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    },
  );

  it('executes a valid human read without channel and reports missing DB honestly', async () => {
    for (const path of [
      '/productos',
      `/productos/${product}`,
      '/productos/por-slug/fixture',
    ]) {
      const result = await harness.call('GET', path);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    }
  });
});
