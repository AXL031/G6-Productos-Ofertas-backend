import { BulkUserBearerGuard } from './bulk-user-bearer.guard.js';

function executionContext(headers: Record<string, string> = {}, remoteAddress = '10.0.0.2') {
  const request = { headers, socket: { remoteAddress } };
  return { request, context: { switchToHttp: () => ({ getRequest: () => request }) } as never };
}

describe('Bulk H4 userBearer and reversible demo policy', () => {
  afterEach(() => {
    delete process.env.GATEWAY_DEMO_NO_AUTH_ENABLED;
    delete process.env.BULK_DEMO_GATEWAY_IPS;
    delete process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.G7_JWT_ISSUER;
  });

  it('D-01/D-09: default is closed and absent credentials never fall back to demo', () => {
    const { context } = executionContext();
    expect(() => new BulkUserBearerGuard().canActivate(context)).toThrow('TOKEN_INVALIDO');
  });

  it('D-02: a malformed or unverifiable bearer is rejected while demo is disabled', () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'false';
    const { context } = executionContext({ authorization: 'Bearer not-a-jwt' });
    expect(() => new BulkUserBearerGuard().canActivate(context)).toThrow('TOKEN_INVALIDO');
  });

  it('D-04 (guard unit boundary): explicit trusted socket IP is the only demo bypass; client identity headers do not populate a user', () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context, request } = executionContext({ authorization: 'Bearer forged', 'x-user-id': 'admin', 'x-roles': 'GESTOR_COMERCIAL' });
    expect(new BulkUserBearerGuard().canActivate(context)).toBe(true);
    expect(Reflect.get(request, 'user')).toBeUndefined();
  });

  it('D-06 boundary: a non-allowlisted peer cannot use demo mode', () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context } = executionContext({}, '198.51.100.20');
    expect(() => new BulkUserBearerGuard().canActivate(context)).toThrow('TOKEN_INVALIDO');
  });
});
