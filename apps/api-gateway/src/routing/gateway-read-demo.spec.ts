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
  it('supports reversible G6_SECURITY_MODE without automatically activating any public operations', async () => {
    expect(readGatewaySettings({}).securityMode).toBe('G7_AUTHENTICATED');
    expect(() =>
      readGatewaySettings({ G6_SECURITY_MODE: 'INVALID_MODE' }),
    ).toThrow('Invalid Gateway configuration');
    expect(() =>
      readGatewaySettings({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        GATEWAY_PUBLIC_OPERATION_IDS: 'crearProducto',
      }),
    ).toThrow('Invalid Gateway configuration');

    // Requisito #3: sin GATEWAY_PUBLIC_OPERATION_IDS explícito, PUBLIC_READ_ONLY
    // mantiene 0 operaciones públicas activadas automáticamente.
    const emptyPhase1Settings = readGatewaySettings({
      G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
    });
    expect(emptyPhase1Settings.publicOperations).toEqual([]);
    const emptyPhase1Identity = new GatewayIdentity(emptyPhase1Settings);
    for (const route of CONTRACT_ROUTES) {
      await expect(
        emptyPhase1Identity.authorize(route, undefined),
      ).rejects.toMatchObject(
        route.security.length
          ? { status: 401, code: 'TOKEN_INVALIDO' }
          : { status: 403, code: 'SCOPE_INSUFICIENTE' },
      );
    }

    // Solo las operaciones GET explícitamente declaradas en GATEWAY_PUBLIC_OPERATION_IDS se habilitan
    const phase1Identity = new GatewayIdentity(
      readGatewaySettings({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        GATEWAY_PUBLIC_OPERATION_IDS:
          'listarProductos,obtenerProductoPorSlug,listarCategorias,listarMarcas',
      }),
    );
    const listarProductos = CONTRACT_ROUTES.find(
      (r) => r.operationId === 'listarProductos',
    )!;
    const obtenerProducto = CONTRACT_ROUTES.find(
      (r) => r.operationId === 'obtenerProducto',
    )!;
    const crearProducto = CONTRACT_ROUTES.find(
      (r) => r.operationId === 'crearProducto',
    )!;
    await expect(
      phase1Identity.authorize(listarProductos, undefined),
    ).resolves.toBeUndefined();
    await expect(
      phase1Identity.authorize(obtenerProducto, undefined),
    ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });
    await expect(
      phase1Identity.authorize(crearProducto, undefined),
    ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });

    expect(() =>
      readGatewaySettings({ G6_SECURITY_MODE: 'SIMULATED_AUTH' }),
    ).toThrow();
    // Phase 3 restores the original authentication requirement.
    for (const mode of ['G7_AUTHENTICATED'] as const) {
      const strictIdentity = new GatewayIdentity(
        readGatewaySettings({
          G6_SECURITY_MODE: mode,
        }),
      );
      await expect(
        strictIdentity.authorize(listarProductos, undefined),
      ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });
    }
  });
});
