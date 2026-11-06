import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PricingWriteAuthorization } from './pricing-write.authorization.js';
import { CatalogServiceToken } from './catalog-token.js';
import { PricingReadGuard } from './pricing-read.guard.js';
import {
  validateEnvironment,
  type PricingConfig,
} from '../config/environment.js';
import { SignedUser } from '../../test/signed-user.js';

describe('autorización de escrituras Pricing con introspección G7', () => {
  const identity = new SignedUser();
  let server: Server;
  let config: PricingConfig;
  let serviceScopes = ['tokens:introspeccion'];
  let introspectionStatus = 200;
  let active = true;
  let introspectionRoles = ['GESTOR_COMERCIAL'];
  let requests: Array<{
    path: string;
    headers: Record<string, string>;
    body: string;
  }> = [];

  const authorize = () => {
    const verifier = new PricingReadGuard(config);
    return new PricingWriteAuthorization(
      config,
      verifier,
      new CatalogServiceToken(config, verifier),
    );
  };

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        path: request.url ?? '',
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : (value ?? ''),
          ]),
        ),
        body,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/jwks') {
        response.end(JSON.stringify({ keys: [identity.jwk] }));
        return;
      }
      if (request.url === '/api/v1/auth/token') {
        const values = new URLSearchParams(body);
        const scopes = values.get('scope')?.split(' ') ?? [];
        response.end(
          JSON.stringify({
            accessToken: identity.token({
              tipo: 'servicio',
              sub: 'modulo-productos',
              aud: 'api-productos',
              scope: serviceScopes.join(' '),
            }),
            tokenType: 'Bearer',
            expiresIn: 180,
            scopes: serviceScopes.filter((scope) => scopes.includes(scope)),
          }),
        );
        return;
      }
      if (request.url === '/api/v1/auth/introspeccion') {
        response.statusCode = introspectionStatus;
        response.end(
          JSON.stringify(
            active
              ? {
                  activo: true,
                  sub: '74ed2f19-7e70-4915-a6f6-bbc691b82587',
                  roles: introspectionRoles,
                  permisos: [],
                  tipo: 'acceso',
                }
              : { activo: false, motivo: 'USUARIO_INACTIVO' },
          ),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 'NOT_FOUND' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as AddressInfo;
    identity.issuer = `http://127.0.0.1:${address.port}`;
    config = validateEnvironment({
      NODE_ENV: 'test',
      PORT: '3002',
      DATABASE_URL: 'postgresql://fixture:fixture@localhost/pricing',
      AUTH_ISSUER: identity.issuer,
      AUTH_JWKS_URL: `${identity.issuer}/jwks`,
      PRICING_SERVICE_TOKEN_URL: `${identity.issuer}/api/v1/auth/token`,
      PRICING_SERVICE_CLIENT_SECRET: 'fixture-secret-only',
    });
  });

  beforeEach(() => {
    serviceScopes = ['tokens:introspeccion'];
    introspectionStatus = 200;
    active = true;
    introspectionRoles = ['GESTOR_COMERCIAL'];
    requests = [];
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('verifica al Gestor y consulta el estado con token técnico del scope requerido', async () => {
    const userToken = identity.token();
    await expect(
      authorize().authorize('actualizarPrecioSku', `Bearer ${userToken}`),
    ).resolves.toBe('74ed2f19-7e70-4915-a6f6-bbc691b82587');
    const tokenRequest = requests.find(
      (request) => request.path === '/api/v1/auth/token',
    )!;
    expect(Object.fromEntries(new URLSearchParams(tokenRequest.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'modulo-productos',
      client_secret: 'fixture-secret-only',
      scope: 'tokens:introspeccion',
    });
    const introspection = requests.find(
      (request) => request.path === '/api/v1/auth/introspeccion',
    )!;
    expect(JSON.parse(introspection.body)).toEqual({ token: userToken });
    expect(introspection.headers.authorization).toMatch(/^Bearer /);
    expect(introspection.body).not.toContain('fixture-secret-only');
  });

  it('rechaza un rol incorrecto antes de llamar a G7', async () => {
    const token = identity.token({ roles: ['VENDEDOR'] });
    await expect(
      authorize().authorize('actualizarPrecioSku', `Bearer ${token}`),
    ).rejects.toMatchObject({ status: 403, code: 'SCOPE_INSUFICIENTE' });
    expect(
      requests.some((request) => request.path.includes('introspeccion')),
    ).toBe(false);
  });

  it('traduce token inactivo a 401 y caída de introspección a 503', async () => {
    active = false;
    await expect(
      authorize().authorize('programarPrecioSku', `Bearer ${identity.token()}`),
    ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });

    active = true;
    introspectionStatus = 503;
    await expect(
      authorize().authorize('programarPrecioSku', `Bearer ${identity.token()}`),
    ).rejects.toMatchObject({ status: 503, code: 'SERVICIO_NO_DISPONIBLE' });
  });

  it('verifica que la identidad y el rol actuales coincidan con el JWT', async () => {
    introspectionRoles = ['VENDEDOR'];
    await expect(
      authorize().authorize(
        'actualizarPrecioSku',
        `Bearer ${identity.token()}`,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'SCOPE_INSUFICIENTE' });
  });

  it('falla cerrado cuando G7 no concede el scope técnico', async () => {
    serviceScopes = [];
    await expect(
      authorize().authorize(
        'actualizarPrecioBaseProducto',
        `Bearer ${identity.token()}`,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'SERVICIO_NO_DISPONIBLE' });
    expect(
      requests.some((request) => request.path.includes('introspeccion')),
    ).toBe(false);
  });
});
