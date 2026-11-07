// Disposable PostgreSQL + native HTTP. Only the upstream commercial facts are fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign, verify, createPublicKey } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PromotionsSvcModule } from '../../../../dist/apps/promotions-svc/promotions-svc.module.js';
import { PromotionsConfigService } from '../../../../dist/apps/promotions-svc/infrastructure/config/promotions-config.js';
import { COUPON_RESOURCES } from '../../../../dist/apps/promotions-svc/coupons/coupon-providers.js';
import { PROMOTIONS_JWKS } from '../../../../dist/apps/promotions-svc/http/promotions-identity.js';
import { PROMOTIONS_SERVICE_TOKENS } from '../../../../dist/apps/promotions-svc/infrastructure/http/integration-providers.js';

export async function verifyHttpUpstreams(resources, baseConfig) {
  const calls = [];
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'upstream-test', alg: 'RS256', use: 'sig' };
  const issuer = 'https://promotions-upstream.test/auth';
  const token = (claims) => {
    const now = Math.floor(Date.now() / 1000);
    const parts = [
      { alg: 'RS256', kid: key.kid, typ: 'JWT' },
      { iss: issuer, sub: randomUUID(), tipo: 'acceso', roles: ['GESTOR_COMERCIAL'], iat: now, exp: now + 300, jti: randomUUID(), ...claims },
    ].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'));
    return `${parts.join('.')}.${sign('RSA-SHA256', Buffer.from(parts.join('.')), pair.privateKey).toString('base64url')}`;
  };
  const userToken = token({});
  const marketplaceToken = token({
    sub: 'modulo-marketplace',
    tipo: 'servicio',
    aud: 'api-productos',
    scope: 'promociones:evaluar',
  });
  const serviceToken = (scope) => token({ sub: 'modulo-productos', tipo: 'servicio', aud: 'api-productos', scope });
  let unavailable = false;
  let categoryActive = true;
  const server = createServer((req, res) => {
    calls.push(req.url);
    const authorization = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization ?? '');
    assert.ok(authorization, 'upstream requires a service bearer');
    const [header, payload, signature] = authorization[1].split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url')), true);
    const serviceClaims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.equal(serviceClaims.tipo, 'servicio');
    assert.equal(serviceClaims.sub, 'modulo-productos');
    assert.equal(serviceClaims.aud, 'api-productos');
    assert.notEqual(authorization[1], userToken);
    res.setHeader('content-type', 'application/json');
    if (unavailable) {
      res.statusCode = 503;
      res.end('{}');
      return;
    }
    const body =
      req.url.includes('/skus/') && req.url.includes('/contexto')
        ? {
            sku: '0001',
            productId: 'UPSTREAM-P',
            isVariant: false,
            active: true,
            eligible: true,
          }
        : req.url.includes('/categorias/')
          ? {
              categoriaId: 'UPSTREAM-C',
              nombre: 'Fixture',
              estado: categoryActive ? 'ACTIVO' : 'INACTIVO',
              version: 1,
            }
          : req.url.includes('/precios/')
            ? {
                sku: '0001',
                precio_regular: 100,
                precio_oferta: 80,
                currency: 'PEN',
                channel_id: null,
                valid_from: '2026-01-01T00:00:00Z',
                valid_until: null,
                price_version: 1,
                vigencia_id: 'V',
                origen: 'PRODUCTO',
              }
            : {
                product_id: 'UPSTREAM-P',
                name: 'Fixture',
                slug: 'fixture',
                categoria_id: 'UPSTREAM-C',
                marca_id: 'M',
                tipo_producto_id: 'T',
                tiene_variantes: false,
                sku_base: '0001',
                marca: { marca_id: 'M', name: 'M' },
                variants: [],
              };
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const upstream = `http://127.0.0.1:${server.address().port}`;
  let app;
  try {
    const module = await Test.createTestingModule({
      imports: [PromotionsSvcModule],
    })
      .overrideProvider(PromotionsConfigService)
      .useValue(
        new PromotionsConfigService({
          ...baseConfig.settings,
          securityMode: 'G7_AUTHENTICATED',
          localDemoEnabled: false,
          auth: { issuer, jwksUrl: 'https://promotions-upstream.test/jwks' },
          upstreams: {
            catalog: upstream,
            pricing: upstream,
            inventory: upstream,
            taxonomy: upstream,
          },
        }),
      )
      .overrideProvider(COUPON_RESOURCES)
      .useValue({ ...resources, onApplicationShutdown: async () => undefined })
      .overrideProvider(PROMOTIONS_JWKS)
      .useValue(async () => [key])
      .overrideProvider(PROMOTIONS_SERVICE_TOKENS)
      .useValue(async (request) => serviceToken(request.scope))
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = async (path, body, expected, bearer = userToken) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + bearer,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(9000),
      });
      const value = await response.json();
      assert.equal(
        response.status,
        expected,
        `${path}: ${JSON.stringify(value)}`,
      );
      return value;
    };
    const promotion = {
      nombre: 'UPSTREAM-HTTP',
      tipoDescuento: 'PORCENTAJE',
      valor: 10,
      modalidad: 'CUPON',
      estado: 'INACTIVO',
      validFrom: '2026-10-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z',
      alcance: { productIds: ['UPSTREAM-P'], skus: ['0001'] },
      prioridad: 1,
      canalesHabilitados: ['MARKETPLACE'],
      politicaCombinacion: {
        ofertaPricing: false,
        promocionAutomatica: false,
        cupon: false,
      },
    };
    const count = async () =>
      (
        await resources.pool.query(
          'SELECT count(*)::int n FROM promotions.promotions',
        )
      ).rows[0].n;
    const before = await count();
    const saved = await call('/api/v1/promociones', promotion, 201);
    assert.equal(await count(), before + 1);
    assert.ok(calls.includes('/api/v1/productos/UPSTREAM-P'));
    assert.ok(calls.includes('/api/v1/productos/skus/0001/contexto'));
    const rule = {
      nombre: 'UPSTREAM-RULE',
      tipo: 'CROSS_SELL',
      origen: { tipo: 'CATEGORIA', id: 'UPSTREAM-C' },
      prioridad: 1,
      estado: 'INACTIVO',
      validFrom: promotion.validFrom,
      validUntil: promotion.validUntil,
      recomendados: [{ productId: 'UPSTREAM-P', orden: 1 }],
    };
    categoryActive = false;
    await call('/api/v1/recomendaciones/reglas', rule, 422);
    categoryActive = true;
    await call('/api/v1/recomendaciones/reglas', rule, 201);
    unavailable = true;
    await call('/api/v1/promociones', promotion, 503);
    assert.equal(await count(), before + 1);
    const reads = calls.length;
    await call(
      `/api/v1/promociones/${saved.promotionId}/desactivar`,
      undefined,
      200,
    );
    assert.equal(calls.length, reads);
    unavailable = false;
    const basket = {
      channel_id: 'MARKETPLACE',
      lines: [{ sku: '0001', quantity: 1 }],
    };
    await call('/api/v1/promociones/evaluar', basket, 200, marketplaceToken);
    assert.ok(
      calls.some((p) =>
        p.startsWith('/api/v1/precios/skus/0001?canal=MARKETPLACE&at='),
      ),
    );
    await call(
      '/api/v1/promociones/evaluar',
      {
        ...basket,
        lines: [{ sku: 'OTHER', product_id: 'UPSTREAM-P', quantity: 1 }],
      },
      400,
      marketplaceToken,
    );
    return [
      'native HTTP/PG module factories: authoritative product/SKU/category writes, inactive category 422, technical failure 503 without write, deactivation independent of upstream, SKU-only basket resolution and product/SKU mismatch 400; inbound bearer never forwarded',
    ];
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
