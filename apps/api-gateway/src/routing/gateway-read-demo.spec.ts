import { GatewayIdentity } from './gateway-identity.js';
import { readGatewaySettings } from './gateway-settings.js';
import { CONTRACT_ROUTES } from './contract-routes.js';

describe('G6 read-only demo Gateway boundary', () => {
  it('requires an explicit boolean flag', () => {
    expect(readGatewaySettings({}).readOnlyDemoEnabled).toBe(false);
    expect(() =>
      readGatewaySettings({ G6_READ_ONLY_DEMO_ENABLED: 'yes' }),
    ).toThrow();
  });
  it('allows exactly the approved GET operations and denies every other contract operation, including writes', async () => {
    const identity = new GatewayIdentity(
      readGatewaySettings({
        G6_READ_ONLY_DEMO_ENABLED: 'true',
      }),
    );
    const approved = [
      'listarProductos',
      'obtenerProducto',
      'obtenerProductoPorSlug',
      'listarCategorias',
      'listarMarcas',
      'obtenerPrecioBaseProducto',
    ];
    for (const route of CONTRACT_ROUTES) {
      if (route.method === 'GET' && approved.includes(route.operationId))
        await expect(
          identity.authorize(route, undefined),
        ).resolves.toBeUndefined();
      else
        await expect(
          identity.authorize(route, undefined),
        ).rejects.toMatchObject({ status: 403, code: 'SCOPE_INSUFICIENTE' });
    }
  });
  it('keeps the ordinary authentication path when the new flag is disabled', async () => {
    const identity = new GatewayIdentity(
      readGatewaySettings({ G6_READ_ONLY_DEMO_ENABLED: 'false' }),
    );
    await expect(
      identity.authorize(CONTRACT_ROUTES[0], undefined),
    ).rejects.toMatchObject({ status: 401 });
  });
});
