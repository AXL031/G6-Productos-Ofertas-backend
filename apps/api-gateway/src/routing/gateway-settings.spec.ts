import { readGatewaySettings, readGatewayPort } from './gateway-settings.js';
import { isRestrictedDemoPeer, matchContractRoute } from './gateway-proxy.js';

describe('Gateway route boundaries and configuration', () => {
  it('preserves the Oracle/CD port and existing override precedence', () => {
    expect(readGatewayPort({})).toBe(3000);
    expect(readGatewayPort({ PORT: '3001', API_GATEWAY_PORT: '3000' })).toBe(
      3000,
    );
    expect(readGatewayPort({ PORT: '3000' })).toBe(3000);
    for (const value of ['0', '65536', '-1', ' 3000', '1.5', 'secret'])
      expect(() => readGatewayPort({ API_GATEWAY_PORT: value })).toThrow(
        'Invalid Gateway port',
      );
  });
  it.each([
    '/health',
    '/health/live',
    '//other.test/ready',
    '/ready?token=secret',
    '/ready#fragment',
    '/a/../ready',
    'https://other.test/ready',
  ])('does not accept liveness or an unsafe readiness target %s', (path) => {
    expect(() =>
      readGatewaySettings({
        GATEWAY_CATALOG_SVC_URL: 'http://catalog.internal',
        GATEWAY_CATALOG_SVC_READINESS_PATH: path,
      }),
    ).toThrow('Invalid Gateway configuration');
  });
  it('requires an enabled upstream for an explicit readiness endpoint', () => {
    expect(() =>
      readGatewaySettings({
        GATEWAY_CATALOG_SVC_READINESS_PATH: '/health/ready',
      }),
    ).toThrow();
    expect(
      readGatewaySettings({
        GATEWAY_CATALOG_SVC_URL: 'http://catalog.internal',
        GATEWAY_CATALOG_SVC_READINESS_PATH: '/health/ready',
      }).readinessPaths,
    ).toEqual({ 'catalog-svc': '/health/ready' });
  });
  it.each([
    'https://user:secret@host',
    'https://host/path',
    'https://host/?secret=1',
    'file:///private',
  ])('rejects unsafe upstream origin without exposing %s', (value) => {
    expect(() =>
      readGatewaySettings({ GATEWAY_CATALOG_SVC_URL: value }),
    ).toThrow('Invalid Gateway configuration');
    try {
      readGatewaySettings({ GATEWAY_CATALOG_SVC_URL: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });
  it('does not permit a protected operation in the anonymous allowlist', () => {
    expect(() =>
      readGatewaySettings({ GATEWAY_PUBLIC_OPERATION_IDS: 'listarProductos' }),
    ).toThrow();
    expect(
      readGatewaySettings({ GATEWAY_PUBLIC_OPERATION_IDS: 'obtenerSeoPorSlug' })
        .publicOperations,
    ).toEqual(['obtenerSeoPorSlug']);
  });
  it('keeps no-auth demo mode disabled unless explicitly enabled', () => {
    expect(readGatewaySettings({}).demoNoAuthEnabled).toBe(false);
    expect(
      readGatewaySettings({ NODE_ENV: 'production' }).demoNoAuthEnabled,
    ).toBe(false);
    expect(
      readGatewaySettings({ AUTH_ISSUER: undefined }).demoNoAuthEnabled,
    ).toBe(false);
    expect(
      readGatewaySettings({ GATEWAY_DEMO_NO_AUTH_ENABLED: 'true' })
        .demoNoAuthEnabled,
    ).toBe(true);
    expect(
      readGatewaySettings({ GATEWAY_DEMO_NO_AUTH_ENABLED: 'false' })
        .demoNoAuthEnabled,
    ).toBe(false);
    expect(() =>
      readGatewaySettings({ GATEWAY_DEMO_NO_AUTH_ENABLED: 'yes' }),
    ).toThrow('Invalid Gateway configuration');
  });
  it('rejects contradictory broad and read-only demo flags at startup', () => {
    expect(() =>
      readGatewaySettings({
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        G6_READ_ONLY_DEMO_ENABLED: 'true',
      }),
    ).toThrow('Invalid Gateway configuration');
    expect(
      readGatewaySettings({ G6_READ_ONLY_DEMO_ENABLED: 'true' })
        .readOnlyDemoEnabled,
    ).toBe(true);
  });
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['10.22.0.4', true],
    ['172.31.255.2', true],
    ['192.168.1.8', true],
    ['::ffff:192.168.1.8', true],
    ['203.0.113.8', false],
    ['8.8.8.8', false],
    ['2001:db8::1', false],
    [undefined, false],
  ])('requires a private TCP peer for demo (%s)', (address, allowed) => {
    expect(isRestrictedDemoPeer(address)).toBe(allowed);
  });
  it('requires explicit demo activation and permits absent G7 trust only in demo', () => {
    expect(
      readGatewaySettings({ GATEWAY_DEMO_NO_AUTH_ENABLED: 'true' }),
    ).toMatchObject({
      demoNoAuthEnabled: true,
      issuer: undefined,
      jwksUrl: undefined,
    });
    expect(() =>
      readGatewaySettings({
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        AUTH_ISSUER: 'not-an-issuer',
      }),
    ).toThrow('Invalid Gateway configuration');
  });
  it('does not allow the environment public allowlist to expose protected operations in demo mode', () => {
    expect(() =>
      readGatewaySettings({
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        GATEWAY_PUBLIC_OPERATION_IDS: 'listarProductos',
      }),
    ).toThrow('Invalid Gateway configuration');
  });
  it('uses static paths before parameter paths and matches the exact method', () => {
    expect(
      matchContractRoute('GET', '/api/v1/promociones/administracion')
        ?.operationId,
    ).toBe('listarPromocionesAdmin');
    expect(
      matchContractRoute('GET', '/api/v1/productos/por-slug/zapatilla')
        ?.operationId,
    ).toBe('obtenerProductoPorSlug');
    expect(
      matchContractRoute('DELETE', '/api/v1/productos/abc'),
    ).toBeUndefined();
  });
  it.each([
    '/api/v1/productos/..',
    '/api/v1/productos/%2e%2e',
    '/api/v1/productos/%2fprivate',
    '/api/v1/productos/%5cprivate',
    '/api/v1/productos/%',
    '//other.test/api/v1/productos',
  ])('rejects traversal or ambiguous paths %s', (path) => {
    expect(matchContractRoute('GET', path)).toBeUndefined();
  });
});
