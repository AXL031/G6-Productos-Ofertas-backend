import { readGatewaySettings } from './gateway-settings.js';
import { CONTRACT_ROUTES } from './contract-routes.js';
import { isEligiblePublicRead } from './gateway-public-reads.js';
import { isDemoBypassRoute } from './gateway-identity.js';
import { createSignedIdentity } from '../../test/support/signed-identity.js';

describe('Phase 1 exact operation policy and JWT coexistence', () => {
  it('permits only the five reviewed candidates, with exact service, method and route', () => {
    expect(
      CONTRACT_ROUTES.filter(isEligiblePublicRead)
        .map((r) => r.operationId)
        .sort(),
    ).toEqual([
      'listarCategorias',
      'listarMarcas',
      'listarProductos',
      'obtenerProducto',
      'obtenerProductoPorSlug',
    ]);
    const route = CONTRACT_ROUTES[0];
    for (const changed of [
      { ...route, method: 'POST' },
      { ...route, path: '/api/v1/other' },
      { ...route, service: 'inventory-svc' },
    ])
      expect(isEligiblePublicRead(changed)).toBe(false);
    for (const operation of [
      'obtenerPreparacionProducto',
      'listarCategoriasAdmin',
      'obtenerPrecioBaseProducto',
      'crearProducto',
    ])
      expect(() =>
        readGatewaySettings({
          G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
          GATEWAY_PUBLIC_OPERATION_IDS: operation,
        }),
      ).toThrow();
  });
  it('rejects legacy bypasses with any explicit phase, regardless of the runtime environment', () => {
    for (const mode of [
      'PUBLIC_READ_ONLY',
      'G7_AUTHENTICATED',
      'SIMULATED_AUTH',
    ])
      for (const flag of [
        'GATEWAY_DEMO_NO_AUTH_ENABLED',
        'G6_READ_ONLY_DEMO_ENABLED',
      ])
        expect(() =>
          readGatewaySettings({
            G6_SECURITY_MODE: mode,
            NODE_ENV: 'production',
            [flag]: 'true',
          }),
        ).toThrow();
    const settings = readGatewaySettings({
      G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      G6_READ_ONLY_DEMO_ENABLED: 'false',
      GATEWAY_PUBLIC_OPERATION_IDS: 'listarProductos',
    });
    expect(
      isDemoBypassRoute(CONTRACT_ROUTES[0], {
        ...settings,
        demoNoAuthEnabled: true,
      }),
    ).toBe(false);
  });
  it('keeps JWT permissions on non-public reads and writes, and validates supplied JWTs on public reads', async () => {
    const settings = readGatewaySettings({
      G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      GATEWAY_PUBLIC_OPERATION_IDS: 'listarProductos',
    });
    const signed = createSignedIdentity(settings);
    const human =
      'Bearer ' +
      signed.token({
        tipo: 'acceso',
        sub: '00000000-0000-4000-8000-000000000001',
        roles: ['GESTOR_COMERCIAL'],
      });
    for (const operation of ['crearProducto', 'obtenerPreparacionProducto']) {
      const route = CONTRACT_ROUTES.find((r) => r.operationId === operation)!;
      await expect(
        signed.identity.authorize(route, human),
      ).resolves.toBeUndefined();
      await expect(
        signed.identity.authorize(route, undefined),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      signed.identity.authorize(CONTRACT_ROUTES[0], undefined),
    ).resolves.toBeUndefined();
    await expect(
      signed.identity.authorize(CONTRACT_ROUTES[0], 'Bearer invalid'),
    ).rejects.toMatchObject({ status: 401 });
  });
});
