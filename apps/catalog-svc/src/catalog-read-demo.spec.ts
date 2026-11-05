import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { AppModule } from './app.module.js';
import {
  CATALOG_READ_DEMO,
  readCatalogReadDemo,
  isDemoCatalogImage,
} from './catalog-read-demo.js';
import {
  CATALOG_SECURITY_CONFIG,
  readCatalogSecurityConfig,
} from './catalog-auth.js';
import {
  CATALOG_TAXONOMY_CONFIG,
  readTaxonomyConfig,
} from './taxonomy-config.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { TaxonomyClient } from './taxonomy.client.js';
import { createDemoIssuer } from '../../../ops/azure/demo-jwt-issuer.mjs';

describe('Explicit internal read-only demo (HTTP provider, isolated repositories)', () => {
  let app: INestApplication;
  const product = {
    product_id: 'fixture',
    name: 'Draft fixture',
    sku_base: 'EXPLICIT-SKU',
    images: [],
    attributes: [],
    variants: [],
  };
  const repository = {
    listCandidates: vi.fn(async () => ({
      items: [product],
      pagina: 1,
      tamanio: 20,
      total: 1,
    })),
    findCandidateByProductId: vi.fn(async () => product),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CATALOG_READ_DEMO)
      .useValue({ enabled: true })
      .overrideProvider(PostgresCatalogRepository)
      .useValue(repository)
      .overrideProvider(TaxonomyClient)
      .useValue({ brand: async () => ({ marca_id: 'brand', name: 'Fixture' }) })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  it('is opt-in, rejects invalid flags, and never activates public operations automatically in PUBLIC_READ_ONLY', () => {
    expect(readCatalogReadDemo({}).enabled).toBe(false);
    expect(
      readCatalogReadDemo({ G6_READ_ONLY_DEMO_ENABLED: 'true' }).enabled,
    ).toBe(true);
    // Requisito #3: sin CATALOG_PUBLIC_OPERATION_IDS explícito, PUBLIC_READ_ONLY mantiene enabled: false y 0 operaciones
    expect(
      readCatalogReadDemo({ G6_SECURITY_MODE: 'PUBLIC_READ_ONLY' }),
    ).toEqual({
      enabled: false,
      securityMode: 'PUBLIC_READ_ONLY',
      publicOperations: [],
    });
    expect(
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        CATALOG_PUBLIC_OPERATION_IDS: 'listarProductos',
      }),
    ).toEqual({
      enabled: true,
      securityMode: 'PUBLIC_READ_ONLY',
      publicOperations: ['listarProductos'],
    });
    expect(
      readCatalogReadDemo({ G6_SECURITY_MODE: 'SIMULATED_AUTH' }),
    ).toMatchObject({ enabled: false, securityMode: 'SIMULATED_AUTH' });
    expect(
      readCatalogReadDemo({ G6_SECURITY_MODE: 'G7_AUTHENTICATED' }),
    ).toMatchObject({ enabled: false, securityMode: 'G7_AUTHENTICATED' });
    expect(() =>
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        CATALOG_PUBLIC_OPERATION_IDS: 'crearProducto',
      }),
    ).toThrow();
    expect(() =>
      readCatalogReadDemo({ G6_READ_ONLY_DEMO_ENABLED: 'yes' }),
    ).toThrow();
    expect(() =>
      readCatalogReadDemo({ G6_SECURITY_MODE: 'INVALID' }),
    ).toThrow();
  });
  it('does not present legacy placeholders as real product photographs', () => {
    expect(
      isDemoCatalogImage(
        'https://placehold.co/800x800/png?text=Imagen+referencial',
      ),
    ).toBe(false);
    expect(isDemoCatalogImage('javascript:alert(1)')).toBe(false);
    expect(isDemoCatalogImage('https://example.test/actual-product.jpg')).toBe(
      true,
    );
  });
  it('reads drafts without JWT or commercial eligibility and keeps input validation', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&estado=BORRADOR')
      .expect(200);
    expect(repository.listCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'BORRADOR' }),
      true,
    );
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=MARKETPLACE&pagina=0')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/productos?canal=invalid')
      .expect(400);
  });
  it('reads existing detail without fabricating a JWT principal', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/productos/fixture?canal=MARKETPLACE')
      .set('Authorization', 'Bearer ignored-demo-input')
      .expect(200);
    expect(repository.findCandidateByProductId).toHaveBeenCalledWith(
      'fixture',
      'MARKETPLACE',
      true,
    );
  });
  it('rejects writes and keeps unrelated protected reads protected', async () => {
    for (const path of [
      '/api/v1/productos',
      '/api/v1/productos/fixture/activar',
      '/api/v1/productos/fixture/preparacion/reintentar',
    ])
      await request(app.getHttpServer()).post(path).send({}).expect(403);
    await request(app.getHttpServer())
      .patch('/api/v1/productos/fixture')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/productos/fixture/preparacion')
      .expect(401);
    await request(app.getHttpServer()).get('/api/v1/no-demo-route').expect(404);
  });
});

describe('Progresión reversible Fase 1 -> Fase 2 -> Fase 3 (G7) y comunicación Catalog -> Taxonomy HTTP', () => {
  const ADMIN_SECRET = 'demo-admin-secret-2026-g6-azure';
  const CLIENT_SECRET = 'demo-productos-client-secret-2026';
  const BRAND_ID = '380d9fe0-0290-580a-95e6-6bcd378b9b92';
  const observedTaxonomyCalls: Array<{
    url: string;
    authorization?: string;
  }> = [];

  it('endurece el emisor JWT simulado (Requisito #5): sin bind público, sin claves privadas en JWKS y sin emisión privilegiada no autorizada', async () => {
    expect(() => createDemoIssuer({ adminSecret: 'short' })).toThrow(
      /DEMO_ISSUER_CONFIG_INVALID/,
    );
    const demo = createDemoIssuer({
      adminSecret: ADMIN_SECRET,
      clients: {
        'modulo-productos': {
          clientSecret: CLIENT_SECRET,
          allowedScopes: ['catalogo:leer'],
        },
      },
    });
    expect(demo.publicJwk).not.toHaveProperty('d');
    expect(demo.publicJwk).not.toHaveProperty('p');
    expect(demo.publicJwk).not.toHaveProperty('q');
    await expect(demo.listenLocalOnly('0.0.0.0', 0)).rejects.toThrow(
      /PUBLIC_BIND_FORBIDDEN/,
    );
    expect(() =>
      demo.mintProfile({
        issuer: 'http://127.0.0.1/api/v1/auth',
        profile: 'user-gestor',
        secret: 'wrong-secret-value-1234',
      }),
    ).toThrow(/UNAUTHORIZED_MINT/);

    const srv = await demo.listenLocalOnly('127.0.0.1', 0);
    try {
      // Sin secreto o con secreto inválido -> 401
      const unauthRes = await fetch(srv.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'modulo-productos',
          client_secret: 'wrong-secret-value-1234',
          scope: 'catalogo:leer',
        }).toString(),
      });
      expect(unauthRes.status).toBe(401);

      // Intento de pedir token humano o rol privilegiado por HTTP -> 403
      const humanAttempt = await fetch(srv.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'modulo-productos',
          client_secret: CLIENT_SECRET,
          scope: 'catalogo:leer',
          roles: 'GESTOR_COMERCIAL',
        }).toString(),
      });
      expect(humanAttempt.status).toBe(403);

      // Intento de pedir scope no autorizado -> 403
      const badScopeAttempt = await fetch(srv.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'modulo-productos',
          client_secret: CLIENT_SECRET,
          scope: 'productos:fisicos:leer',
        }).toString(),
      });
      expect(badScopeAttempt.status).toBe(403);

      // Solicitud M2M autorizada -> 200
      const validM2m = await fetch(srv.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'modulo-productos',
          client_secret: CLIENT_SECRET,
          scope: 'catalogo:leer',
        }).toString(),
      });
      expect(validM2m.status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('verifica Fase 1 (sin y con lista explícita), Fase 2 (SIMULATED_AUTH), comunicación Catalog->Taxonomy y restauración Fase 3 (G7)', async () => {
    const simulatedIssuer = createDemoIssuer({
      adminSecret: ADMIN_SECRET,
      kid: 'sim-key-1',
    });
    const g7Issuer = createDemoIssuer({
      adminSecret: 'g7-real-issuer-secret-2026',
      kid: 'g7-key-1',
    });
    const simServer = await simulatedIssuer.listenLocalOnly('127.0.0.1', 0);
    const g7Server = await g7Issuer.listenLocalOnly('127.0.0.1', 0);

    let taxonomyPhase: 'PUBLIC_READ_ONLY' | 'AUTHENTICATED' =
      'PUBLIC_READ_ONLY';
    const taxonomyHttp = createServer((req, res) => {
      observedTaxonomyCalls.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
      });
      res.setHeader('content-type', 'application/json');
      if (taxonomyPhase === 'AUTHENTICATED' && !req.headers.authorization) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 'TOKEN_INVALIDO' }));
        return;
      }
      if (req.url === '/api/v1/marcas') {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            brands: [
              {
                marca_id: BRAND_ID,
                name: 'Marathon',
                status: 'ACTIVA',
                description: null,
                logo_url: null,
                country_code: 'EC',
              },
            ],
          }),
        );
        return;
      }
      if (req.url === `/api/v1/marcas/${BRAND_ID}`) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            marcaId: BRAND_ID,
            nombre: 'Marathon',
            estado: 'ACTIVO',
            version: 1,
            descripcion: null,
            logoUrl: null,
            paisOrigenIso: 'EC',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    taxonomyHttp.listen(0, '127.0.0.1');
    await once(taxonomyHttp, 'listening');
    const taxAddr = taxonomyHttp.address();
    if (!taxAddr || typeof taxAddr === 'string') throw new Error();
    const taxonomyOrigin = `http://127.0.0.1:${taxAddr.port}`;

    const repoFixture = {
      listCandidates: vi.fn(async () => ({
        items: [],
        pagina: 1,
        tamanio: 20,
        total: 0,
      })),
      findCandidateBySlug: vi.fn(async () => ({
        product_id: 'prod-1',
        slug: 'zapatilla-marathon',
        name: 'Zapatilla Marathon',
        description: 'Calzado deportivo',
        categoria_id: 'cat-1',
        tipo_producto_id: 'type-1',
        marca_id: BRAND_ID,
        tiene_variantes: false,
        sku_base: 'SKU-1',
        images: [],
        attributes: [],
        variants: [],
      })),
      findCandidateByProductId: vi.fn(async () => null),
    };

    async function bootCatalog(env: Record<string, string | undefined>) {
      const mod = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CATALOG_READ_DEMO)
        .useValue(readCatalogReadDemo(env))
        .overrideProvider(CATALOG_SECURITY_CONFIG)
        .useValue(readCatalogSecurityConfig(env))
        .overrideProvider(CATALOG_TAXONOMY_CONFIG)
        .useValue(readTaxonomyConfig({ CATALOG_TAXONOMY_URL: taxonomyOrigin }))
        .overrideProvider(PostgresCatalogRepository)
        .useValue(repoFixture)
        .compile();
      const instance = mod.createNestApplication({ logger: false });
      await instance.init();
      return instance;
    }

    try {
      // 1) Fase 1 con lista vacía: 0 operaciones públicas automáticas
      const appPhase1Empty = await bootCatalog({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      });
      await request(appPhase1Empty.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .expect(401);
      await request(appPhase1Empty.getHttpServer())
        .post('/api/v1/productos')
        .send({})
        .expect(403);
      await appPhase1Empty.close();

      // 2) Fase 1 con lista explícita (obtenerProductoPorSlug): lectura pública aprobada + Catalog->Taxonomy sin JWT
      observedTaxonomyCalls.length = 0;
      taxonomyPhase = 'PUBLIC_READ_ONLY';
      const appPhase1Explicit = await bootCatalog({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        CATALOG_PUBLIC_OPERATION_IDS: 'obtenerProductoPorSlug',
      });
      await request(appPhase1Explicit.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .expect(200);
      expect(observedTaxonomyCalls).toEqual([
        { url: '/api/v1/marcas', authorization: undefined },
      ]);
      // Operación GET no incluida en CATALOG_PUBLIC_OPERATION_IDS (listarProductos) sigue protegida (401)
      await request(appPhase1Explicit.getHttpServer())
        .get('/api/v1/productos?canal=MARKETPLACE')
        .expect(401);
      // Escrituras siguen denegadas (403)
      await request(appPhase1Explicit.getHttpServer())
        .post('/api/v1/productos')
        .send({})
        .expect(403);
      await appPhase1Explicit.close();

      // 3) Fase 2 (SIMULATED_AUTH): lectura anónima rechazada (401), tokens simulados válidos aceptados (200)
      taxonomyPhase = 'AUTHENTICATED';
      const appPhase2 = await bootCatalog({
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SECURITY_ISSUER: simServer.issuer,
        SECURITY_DISCOVERY_URL: simServer.discoveryUrl,
        SECURITY_JWKS_URL: simServer.jwksUrl,
      });
      await request(appPhase2.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .expect(401);

      const m2mToken = simulatedIssuer.mintProfile({
        issuer: simServer.issuer,
        profile: 'm2m-marketplace',
        secret: ADMIN_SECRET,
      });
      observedTaxonomyCalls.length = 0;
      await request(appPhase2.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .set('Authorization', `Bearer ${m2mToken}`)
        .expect(200);
      // Con token de servicio, Catalog invoca GET /api/v1/marcas propagando el Bearer token
      expect(observedTaxonomyCalls).toEqual([
        { url: '/api/v1/marcas', authorization: `Bearer ${m2mToken}` },
      ]);

      const gestorToken = simulatedIssuer.mintProfile({
        issuer: simServer.issuer,
        profile: 'user-gestor',
        secret: ADMIN_SECRET,
      });
      observedTaxonomyCalls.length = 0;
      await request(appPhase2.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .set('Authorization', `Bearer ${gestorToken}`)
        .expect(200);
      // Con token de usuario GESTOR_COMERCIAL, Catalog invoca GET /api/v1/marcas/{id} propagando el Bearer token
      expect(observedTaxonomyCalls).toEqual([
        {
          url: `/api/v1/marcas/${BRAND_ID}`,
          authorization: `Bearer ${gestorToken}`,
        },
      ]);

      // Tokens negativos en Fase 2: scope insuficiente (403), sin rol GESTOR_COMERCIAL (403), expirado (401)
      const invalidScopeToken = simulatedIssuer.mintProfile({
        issuer: simServer.issuer,
        profile: 'invalid-scope',
        secret: ADMIN_SECRET,
      });
      await request(appPhase2.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .set('Authorization', `Bearer ${invalidScopeToken}`)
        .expect(403);

      const noRoleToken = simulatedIssuer.mintProfile({
        issuer: simServer.issuer,
        profile: 'user-sin-rol',
        secret: ADMIN_SECRET,
      });
      await request(appPhase2.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .set('Authorization', `Bearer ${noRoleToken}`)
        .expect(403);

      const expiredToken = simulatedIssuer.mintProfile({
        issuer: simServer.issuer,
        profile: 'expired',
        secret: ADMIN_SECRET,
      });
      await request(appPhase2.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      await appPhase2.close();

      // 4) Restauración de Fase 3 (G7_AUTHENTICATED): rechaza tokens del emisor simulado (401) y acepta solo G7 (200)
      const appPhase3G7 = await bootCatalog({
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        SECURITY_ISSUER: g7Server.issuer,
        SECURITY_DISCOVERY_URL: g7Server.discoveryUrl,
        SECURITY_JWKS_URL: g7Server.jwksUrl,
      });
      await request(appPhase3G7.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .set('Authorization', `Bearer ${m2mToken}`)
        .expect(401);

      const g7M2mToken = g7Issuer.mintProfile({
        issuer: g7Server.issuer,
        profile: 'm2m-marketplace',
        secret: 'g7-real-issuer-secret-2026',
      });
      await request(appPhase3G7.getHttpServer())
        .get('/api/v1/productos/por-slug/zapatilla-marathon?canal=MARKETPLACE')
        .set('Authorization', `Bearer ${g7M2mToken}`)
        .expect(200);
      await appPhase3G7.close();
    } finally {
      await simServer.close();
      await g7Server.close();
      await new Promise<void>((r) => taxonomyHttp.close(() => r()));
    }
  });
});
