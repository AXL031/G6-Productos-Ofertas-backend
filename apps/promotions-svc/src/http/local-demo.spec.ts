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

describe('Promotions legacy local demo access', () => {
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());

  it('rejects the removed broad no-auth flag during configuration', () => {
    expect(() =>
      validatePromotionsConfiguration({
        ...fixture.environment,
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      }),
    ).toThrow();
  });

  it.each(Object.keys(httpContracts))(
    'requires an authenticated identity for %s despite spoofed peer headers',
    async (id) => {
      const config = new PromotionsConfigService(
        validatePromotionsConfiguration(fixture.environment),
      );
      const identity = new PromotionsIdentity(config, async () => []);
      const authorize = vi.spyOn(identity, 'authorize');
      const reflector = new Reflector();
      vi.spyOn(reflector, 'get').mockReturnValue(id);
      const operation = httpContracts[id];
      const request = {
        method: operation.method,
        path: operation.path.replace(/\{[^}]+\}/g, 'test-id'),
        socket: { remoteAddress: '172.20.0.2' },
        headers: {
          'x-user-role': 'GESTOR_COMERCIAL',
          'x-forwarded-for': '127.0.0.1',
          'x-gateway-identity': 'trusted',
        },
        header: (): string | undefined => undefined,
      };
      const context = {
        getHandler: () => () => undefined,
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
      const guard = new PromotionsQueryGuard(reflector, identity, config);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 401,
      });
      expect(authorize).toHaveBeenCalledOnce();
    },
  );
});
