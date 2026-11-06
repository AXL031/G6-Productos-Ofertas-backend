import { randomUUID } from 'node:crypto';
import { CatalogGatewayHarness } from './support/catalog-gateway-harness.js';

describe('Historical recovery candidate HTTP authorization (signed JWT/JWKS, no database)', () => {
  const closed = new CatalogGatewayHarness();
  const enabled = new CatalogGatewayHarness();
  const subject = '00000000-0000-4000-8000-000000000050';
  const path =
    '/productos/' + randomUUID() + '/preparacion/recuperar-historica';
  const body = { solicitudId: randomUUID(), dependencias: ['INVENTARIO'] };
  beforeAll(async () => {
    await closed.start(undefined, {}, true);
    await enabled.start(undefined, {}, true, [subject]);
  });
  afterAll(async () => {
    await enabled.close();
    await closed.close();
  });
  it('denies the capability by default, including during restricted demo', async () => {
    expect(
      (await closed.call('POST', path, body, closed.token(), true)).status,
    ).toBe(403);
  });
  it('requires an authentic human with the global role and configured capability', async () => {
    expect((await enabled.call('POST', path, body, null, true)).status).toBe(
      401,
    );
    for (const claims of [
      { roles: [] },
      { sub: randomUUID() },
      {
        tipo: 'servicio',
        sub: 'modulo-productos',
        scope: 'catalogo:leer',
        roles: [],
      },
    ]) {
      expect(
        (await enabled.call('POST', path, body, enabled.token(claims), true))
          .status,
      ).toBe(403);
    }
    expect(
      (await enabled.call('POST', path, body, enabled.token({}, true), true))
        .status,
    ).toBe(401);
  });
  it('keeps historical Pricing closed before any persistence, without inventing its payload', async () => {
    const response = await enabled.call(
      'POST',
      path,
      { ...body, dependencias: ['PRICING', 'INVENTARIO'] },
      enabled.token(),
      true,
    );
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });
});
