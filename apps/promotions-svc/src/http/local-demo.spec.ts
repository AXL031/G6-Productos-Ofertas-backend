import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PromotionsIdentity,
  PromotionsQueryGuard,
} from './promotions-identity.js';
import { httpContracts } from './http-contract.generated.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../infrastructure/config/promotions-config.js';
import { createEnvironmentFixture } from '../../test/support/environment.js';

describe('Promotions local demo access', () => {
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());
  const setup = (enabled: boolean, id = 'crearCupon', peer = '127.0.0.1') => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        GATEWAY_DEMO_NO_AUTH_ENABLED: String(enabled),
      }),
    );
    const identity = new PromotionsIdentity(config, async () => []);
    const authorize = vi.spyOn(identity, 'authorize');
    const reflector = new Reflector();
    vi.spyOn(reflector, 'get').mockReturnValue(id);
    const operation = httpContracts[id];
    const req = {
      method: operation?.method ?? 'POST',
      path: operation?.path.replace(/\{[^}]+\}/g, 'test-id') ?? '/unknown',
      socket: { remoteAddress: peer },
      headers: {
        'x-user-role': 'GESTOR_COMERCIAL',
        'x-forwarded-for': '127.0.0.1',
      },
      header: () => undefined,
    };
    const context = {
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return {
      guard: new PromotionsQueryGuard(reflector, identity, config),
      authorize,
      req,
      context,
    };
  };

  it.each(Object.keys(httpContracts))(
    'allows the existing %s handler locally without inventing identity',
    async (id) => {
      const test = setup(true, id);
      expect(await test.guard.canActivate(test.context)).toBe(true);
      expect(test.authorize).not.toHaveBeenCalled();
      expect(test.req).not.toHaveProperty('user');
    },
  );

  it('restores JWT authorization when demo is disabled', async () => {
    const test = setup(false);
    await expect(test.guard.canActivate(test.context)).rejects.toMatchObject({
      status: 401,
    });
    expect(test.authorize).toHaveBeenCalledOnce();
  });

  it.each(['192.168.1.5', '10.0.0.2', '::ffff:192.168.1.5', ''])(
    'denies peer %j even with spoofed forwarding/identity headers',
    async (peer) => {
      const test = setup(true, 'crearCupon', peer);
      await expect(test.guard.canActivate(test.context)).rejects.toMatchObject({
        status: 403,
      });
      expect(test.authorize).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown operations, mismatched paths and methods', async () => {
    const unknown = setup(true, 'inventedOperation');
    await expect(
      unknown.guard.canActivate(unknown.context),
    ).rejects.toMatchObject({ status: 503 });
    for (const changes of [
      { method: 'DELETE' },
      { path: '/api/v1/invented' },
    ]) {
      const test = setup(true);
      Object.assign(test.req, changes);
      await expect(test.guard.canActivate(test.context)).rejects.toMatchObject({
        status: 403,
      });
    }
  });
});
