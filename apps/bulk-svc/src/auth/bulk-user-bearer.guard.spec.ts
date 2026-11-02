import { BulkUserBearerGuard } from './bulk-user-bearer.guard.js';
import { generateKeyPairSync, createSign } from 'node:crypto';

function executionContext(
  headers: Record<string, string> = {},
  remoteAddress = '10.0.0.2',
) {
  const request = { headers, socket: { remoteAddress } };
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }) } as never,
  };
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
    expect(() => new BulkUserBearerGuard().canActivate(context)).toThrow(
      'TOKEN_INVALIDO',
    );
  });

  it('D-02: a malformed or unverifiable bearer is rejected while demo is disabled', () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'false';
    const { context } = executionContext({ authorization: 'Bearer not-a-jwt' });
    expect(() => new BulkUserBearerGuard().canActivate(context)).toThrow(
      'TOKEN_INVALIDO',
    );
  });

  it('rejects an otherwise valid locally signed RS256 token whose nbf is in the future', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    process.env.G7_JWT_ISSUER = 'test-issuer';
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const claims = encode({
      iss: 'test-issuer',
      sub: 'unit-test-subject',
      aud: 'api-productos',
      exp: Math.floor(Date.now() / 1000) + 600,
      nbf: Math.floor(Date.now() / 1000) + 600,
      roles: ['GESTOR_COMERCIAL'],
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const { context } = executionContext({
      authorization: `Bearer ${header}.${claims}.${signer.sign(privateKey, 'base64url')}`,
    });
    expect(() => new BulkUserBearerGuard().canActivate(context)).toThrow(
      'TOKEN_INVALIDO',
    );
  });

  it('D-04 (guard unit boundary): explicit trusted socket IP is the only demo bypass; client identity headers do not populate a user', () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context, request } = executionContext({
      authorization: 'Bearer forged',
      'x-user-id': 'admin',
      'x-roles': 'GESTOR_COMERCIAL',
    });
    expect(new BulkUserBearerGuard().canActivate(context)).toBe(true);
    expect(Reflect.get(request, 'user')).toBeUndefined();
  });

  it('D-06 boundary: a non-allowlisted peer cannot use demo mode', () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context } = executionContext({}, '198.51.100.20');
    expect(() => new BulkUserBearerGuard().canActivate(context)).toThrow(
      'TOKEN_INVALIDO',
    );
  });
});
