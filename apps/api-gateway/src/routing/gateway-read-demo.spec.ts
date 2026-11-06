import { GatewayIdentity } from './gateway-identity.js';
import { readGatewaySettings } from './gateway-settings.js';
import { CONTRACT_ROUTES } from './contract-routes.js';

describe('G6 read-only demo Gateway boundary', () => {
  it('requires an explicit boolean flag', () => {
    expect(readGatewaySettings({}).readOnlyDemoEnabled).toBe(false);
    expect(() =>
      readGatewaySettings({ G6_READ_ONLY_DEMO_ENABLED: 'yes' }),
    ).toThrow();
    expect(() =>
      readGatewaySettings({ G6_READ_ONLY_DEMO_ENABLED: 'true' }),
    ).toThrow();
  });
  it('rejects the retired read-only flag instead of changing authorization implicitly', async () => {
    expect(
      () =>
        new GatewayIdentity(
          readGatewaySettings({ G6_READ_ONLY_DEMO_ENABLED: 'true' }),
        ),
    ).toThrow('Invalid Gateway configuration');
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

    const simulated = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'SIMULATED_AUTH',
      SIMULATED_AUTH_ISSUER: 'http://127.0.0.1:8080/simulated-auth',
      SIMULATED_AUTH_JWKS_URL: 'http://127.0.0.1:8080/jwks',
    });
    expect(simulated).toMatchObject({
      securityMode: 'SIMULATED_AUTH',
      issuer: 'http://127.0.0.1:8080/simulated-auth',
      jwksUrl: 'http://127.0.0.1:8080/jwks',
    });
    const simulatedIdentity = new GatewayIdentity(simulated);
    await expect(
      simulatedIdentity.authorize(listarProductos, undefined),
    ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });
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
