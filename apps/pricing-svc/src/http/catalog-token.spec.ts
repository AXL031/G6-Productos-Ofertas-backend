import { createServer, type Server } from 'node:http';
import { SignedUser } from '../../test/signed-user.js';
import { CatalogServiceToken } from './catalog-token.js';
import { PricingReadGuard } from './pricing-read.guard.js';
import {
  validateEnvironment,
  type PricingConfig,
} from '../config/environment.js';

describe('Credencial propia de Pricing para Catalog (G7 client_credentials)', () => {
  const identity = new SignedUser();
  let server: Server;
  let config: PricingConfig;
  let requests: string[] = [];
  let response: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let status = 200;
  let delay = 0;
  const client = () =>
    new CatalogServiceToken(config, new PricingReadGuard(config));
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [identity.jwk] }));
        return;
      }
      let input = '';
      for await (const part of req) input += part.toString();
      requests.push(input);
      const send = () => {
        res.statusCode = status;
        res.end(
          JSON.stringify({
            accessToken: identity.token({
              tipo: 'servicio',
              sub: 'modulo-productos',
              aud: 'api-productos',
              scope: 'catalogo:leer',
              ...claims,
            }),
            tokenType: 'Bearer',
            expiresIn: 300,
            scopes: ['catalogo:leer'],
            ...response,
          }),
        );
      };
      if (delay) setTimeout(send, delay);
      else send();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture sin puerto');
    identity.issuer = `http://127.0.0.1:${address.port}`;
    config = validateEnvironment({
      NODE_ENV: 'test',
      PORT: '3002',
      DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
      AUTH_ISSUER: identity.issuer,
      AUTH_JWKS_URL: identity.issuer + '/jwks',
      PRICING_SERVICE_TOKEN_URL: identity.issuer + '/api/v1/auth/token',
      PRICING_SERVICE_CLIENT_SECRET: 'fixture-private-secret',
    });
  });
  beforeEach(() => {
    requests = [];
    response = {};
    claims = {};
    status = 200;
    delay = 0;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('solicita solo catalogo:leer con identidad propia y verifica/cachea JWT firmado', async () => {
    const tokens = client();
    const token = await tokens.get();
    expect(await tokens.get()).toBe(token);
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(requests[0]))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'modulo-productos',
      client_secret: 'fixture-private-secret',
      scope: 'catalogo:leer',
    });
  });
  it.each([
    { sub: 'modulo-marketplace' },
    { tipo: 'acceso' },
    { aud: 'other' },
    { iss: 'https://wrong.invalid' },
    { exp: 1 },
    { scope: 'precios:leer' },
  ])('rechaza claims firmados incorrectos %j', async (invalid) => {
    claims = invalid;
    await expect(client().get()).rejects.toMatchObject({
      status: 503,
      message: 'SERVICIO_NO_DISPONIBLE',
    });
  });
  it.each([
    { accessToken: 'invalid' },
    { scopes: [] },
    { tokenType: 'Other' },
    { expiresIn: 0 },
    { expiresIn: '300' },
    { accessToken: 'x'.repeat(65537) },
  ])('rechaza respuesta G7 incompatible %j', async (invalid) => {
    response = invalid;
    await expect(client().get()).rejects.toMatchObject({ status: 503 });
  });
  it('no reutiliza cache vencida si G7 falla', async () => {
    const tokens = client();
    await tokens.get();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 301000);
    status = 503;
    await expect(tokens.get()).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(2);
  });
  it('no consulta G7 en demo ni sin credenciales configuradas', async () => {
    expect(
      await new CatalogServiceToken(
        { ...config, demoNoAuthEnabled: true },
        new PricingReadGuard(config),
      ).get(),
    ).toBeNull();
    await expect(
      new CatalogServiceToken(
        { ...config, serviceToken: undefined },
        new PricingReadGuard(config),
      ).get(),
    ).rejects.toMatchObject({ status: 503 });
    expect(requests).toEqual([]);
  });
  it('acota el tiempo del endpoint de tokens', async () => {
    delay = 1200;
    await expect(client().get()).rejects.toMatchObject({ status: 503 });
  });
  it('rechaza credenciales incompletas y endpoint fuera del issuer', () => {
    const env = {
      NODE_ENV: 'test',
      PORT: '3002',
      DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
      AUTH_ISSUER: identity.issuer,
      AUTH_JWKS_URL: identity.issuer + '/jwks',
    };
    for (const extra of [
      { PRICING_SERVICE_CLIENT_SECRET: 'fixture' },
      { PRICING_SERVICE_TOKEN_URL: identity.issuer + '/api/v1/auth/token' },
      {
        PRICING_SERVICE_CLIENT_SECRET: 'fixture',
        PRICING_SERVICE_TOKEN_URL: 'https://other.invalid/api/v1/auth/token',
      },
      {
        PRICING_SERVICE_CLIENT_SECRET: 'fixture',
        PRICING_SERVICE_TOKEN_URL: identity.issuer + '/wrong-path',
      },
    ])
      expect(() => validateEnvironment({ ...env, ...extra })).toThrow();
  });
});
