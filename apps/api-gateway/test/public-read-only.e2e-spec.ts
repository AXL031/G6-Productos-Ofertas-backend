import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { once } from 'node:events';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';
import { AppModule as CatalogModule } from '../../catalog-svc/src/app.module.js';
import { CatalogConfig } from '../../catalog-svc/src/config.js';
import { Database as CatalogDatabase } from '../../catalog-svc/src/database.js';
import { TaxonomySvcModule } from '../../taxonomy-svc/src/taxonomy-svc.module.js';
import { Database as TaxonomyDatabase } from '../../taxonomy-svc/src/database.js';
import { Phase1Postgres } from './support/phase1-postgres.js';

const id = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const operations =
  'listarProductos,obtenerProducto,obtenerProductoPorSlug,listarCategorias,listarMarcas';
const paths = [
  '/api/v1/categorias',
  '/api/v1/marcas',
  '/api/v1/productos?canal=MARKETPLACE',
  `/api/v1/productos/${id(10)}?canal=MARKETPLACE`,
  '/api/v1/productos/por-slug/visible?canal=MARKETPLACE',
];

/** Real HTTP Gateway -> Catalog -> Taxonomy, real PostgreSQL/TLS and real JWT
 * verification. Only the issuer is a cryptographic test fixture, never real G7.
 * Fails rather than silently skipping when Docker/OpenSSL are unavailable.
 */
describe('Phase 1 real three-service integration on disposable PostgreSQL', () => {
  const postgres = new Phase1Postgres();
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const originalCa = getCACertificates('default');
  let issuerServer: Server;
  let issuer = '';
  let taxonomy: INestApplication | undefined;
  let catalog: INestApplication | undefined;
  let gateway: INestApplication | undefined;
  let persistedBefore = '';
  const snapshot = () =>
    postgres.sql(`SELECT jsonb_build_array(
    (SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM catalog.products p),
    (SELECT md5(jsonb_agg(to_jsonb(v) ORDER BY id)::text) FROM catalog.variants v),
    (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM taxonomy.categories c),
    (SELECT md5(jsonb_agg(to_jsonb(b) ORDER BY id)::text) FROM taxonomy.brands b),
    (SELECT count(*) FROM catalog.outbox), (SELECT count(*) FROM taxonomy.outbox),
    (SELECT count(*) FROM catalog.inbox), (SELECT count(*) FROM taxonomy.inbox));`);

  function token(
    claims: Record<string, unknown> = {},
    invalidSignature = false,
  ) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'phase1-fixture' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: 'modulo-marketplace',
        tipo: 'servicio',
        aud: 'api-productos',
        scope: 'catalogo:leer',
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...claims,
      }),
    ).toString('base64url');
    const key = invalidSignature
      ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      : keys.privateKey;
    const body = header + '.' + payload;
    return (
      body +
      '.' +
      sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')
    );
  }

  async function closeServices() {
    await gateway?.close();
    gateway = undefined;
    await catalog?.close();
    catalog = undefined;
    await taxonomy?.close();
    taxonomy = undefined;
  }

  async function restart(
    mode: 'PUBLIC_READ_ONLY' | 'G7_AUTHENTICATED',
    enabled = true,
    taxonomyEnabled = enabled,
    gatewayEnabled = enabled,
  ) {
    await closeServices();
    const security = {
      SECURITY_ISSUER: issuer,
      SECURITY_DISCOVERY_URL: issuer + '/discovery',
      SECURITY_JWKS_URL: issuer + '/jwks',
    };
    const taxEnv = {
      ...postgres.env('taxonomy'),
      ...security,
      G6_SECURITY_MODE: mode,
      TAXONOMY_PUBLIC_OPERATION_IDS:
        mode === 'PUBLIC_READ_ONLY' && taxonomyEnabled
          ? 'listarCategorias,listarMarcas'
          : '',
    };
    const taxModule = await Test.createTestingModule({
      imports: [TaxonomySvcModule.forRuntime(taxEnv)],
    }).compile();
    taxonomy = taxModule.createNestApplication({ logger: false });
    await taxonomy.get(TaxonomyDatabase).verifyIdentity(taxEnv);
    await taxonomy.listen(0, '127.0.0.1');
    const config = new CatalogConfig({
      ...postgres.env('catalog'),
      ...security,
      CATALOG_SVC_PORT: '3001',
      CATALOG_TAXONOMY_URL: await taxonomy.getUrl(),
      G6_SECURITY_MODE: mode,
      CATALOG_PUBLIC_OPERATION_IDS:
        mode === 'PUBLIC_READ_ONLY' && enabled
          ? 'listarProductos,obtenerProducto,obtenerProductoPorSlug'
          : '',
    });
    const catModule = await Test.createTestingModule({
      imports: [CatalogModule.forRoot(config)],
    }).compile();
    catalog = catModule.createNestApplication({ logger: false });
    await catalog.get(CatalogDatabase).verifyIdentity();
    await catalog.listen(0, '127.0.0.1');
    const settings = readGatewaySettings({
      G6_SECURITY_MODE: mode,
      AUTH_ISSUER: issuer,
      AUTH_JWKS_URL: issuer + '/jwks',
      GATEWAY_CATALOG_SVC_URL: await catalog.getUrl(),
      GATEWAY_TAXONOMY_SVC_URL: await taxonomy.getUrl(),
      GATEWAY_PUBLIC_OPERATION_IDS:
        mode === 'PUBLIC_READ_ONLY' && gatewayEnabled ? operations : '',
    });
    const gwModule = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .compile();
    gateway = gwModule.createNestApplication({
      logger: false,
      bodyParser: false,
    });
    await gateway.listen(0, '127.0.0.1');
  }

  beforeAll(async () => {
    await postgres.start();
    // Adversarial visibility fixtures, not an activation-flow test. Triggers are
    // suspended only for these inserts in the newly created disposable database.
    postgres.sql(`SET session_replication_role=replica;
      INSERT INTO taxonomy.categories(id,nombre,estado) VALUES ('${id(1)}','Visible category','ACTIVO'),('${id(2)}','Hidden category','INACTIVO');
      INSERT INTO taxonomy.brands(id,nombre,estado) VALUES ('${id(3)}','Visible brand','ACTIVO'),('${id(4)}','Hidden brand','INACTIVO');
      INSERT INTO catalog.products(id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes,estado) VALUES
        ('${id(10)}','A visible','Public product','${id(1)}','type','${id(3)}','SIMPLE','visible',false,'ACTIVO'),
        ('${id(11)}','B draft','Private draft','${id(1)}','type','${id(3)}','DRAFT','draft',false,'BORRADOR'),
        ('${id(12)}','C inactive','Private inactive','${id(1)}','type','${id(3)}','INACTIVE','inactive',false,'INACTIVO'),
        ('${id(13)}','D empty parent','No active variants','${id(1)}','type','${id(3)}','EMPTY','empty',true,'ACTIVO'),
        ('${id(14)}','E parent','Has active variant','${id(1)}','type','${id(3)}','PARENT','parent',true,'ACTIVO');
      INSERT INTO catalog.variants(id,product_id,sku,identifying_key,estado) VALUES
        ('${id(20)}','${id(14)}','ACTIVE-VARIANT','{"size":"M"}','ACTIVA'),
        ('${id(21)}','${id(14)}','HIDDEN-VARIANT','{"size":"L"}','INACTIVA');
      RESET session_replication_role;`);
    persistedBefore = snapshot();
    setDefaultCACertificates([
      ...originalCa,
      readFileSync(postgres.certificate, 'utf8'),
    ]);
    issuerServer = createServer(
      {
        key: readFileSync(postgres.key),
        cert: readFileSync(postgres.certificate),
      },
      (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/issuer/jwks')
          res.end(
            JSON.stringify({
              keys: [
                {
                  ...keys.publicKey.export({ format: 'jwk' }),
                  kid: 'phase1-fixture',
                  use: 'sig',
                  alg: 'RS256',
                },
              ],
            }),
          );
        else if (req.url === '/issuer/discovery')
          res.end(JSON.stringify({ issuer, jwks_uri: issuer + '/jwks' }));
        else {
          res.statusCode = 404;
          res.end('{}');
        }
      },
    );
    issuerServer.listen(0, '127.0.0.1');
    await once(issuerServer, 'listening');
    const address = issuerServer.address();
    if (!address || typeof address === 'string')
      throw new Error('No local issuer port');
    issuer = `https://localhost:${address.port}/issuer`;
  }, 90000);

  afterAll(async () => {
    await closeServices();
    if (issuerServer)
      await new Promise<void>((resolve) => issuerServer.close(() => resolve()));
    setDefaultCACertificates(originalCa);
    await postgres.close();
  }, 30000);

  it('keeps every operation protected when all runtime lists are empty', async () => {
    await restart('PUBLIC_READ_ONLY', false);
    for (const path of paths)
      await request(gateway!.getHttpServer()).get(path).expect(401);
  });

  it('serves the five exact public reads and real Catalog ID/slug -> Taxonomy enrichment', async () => {
    await restart('PUBLIC_READ_ONLY');
    for (const path of paths) {
      const response = await request(gateway!.getHttpServer())
        .get(path)
        .expect(200);
      if (path.includes('/productos/'))
        expect(response.body.marca.name).toBe('Visible brand');
    }
    const category = await request(gateway!.getHttpServer())
      .get(paths[0])
      .expect(200);
    expect(
      category.body.categories.map(
        (row: { categoria_id: string }) => row.categoria_id,
      ),
    ).toEqual([id(1)]);
    const brands = await request(gateway!.getHttpServer())
      .get(paths[1])
      .expect(200);
    expect(
      brands.body.brands.map((row: { marca_id: string }) => row.marca_id),
    ).toEqual([id(3)]);
    await request(gateway!.getHttpServer())
      .get(paths[2] + `&categoriaId=${id(1)}&marcaId=${id(3)}`)
      .expect(200);
  });

  it('applies eligibility before count/page, hides drafts/inactive/empty parents and inactive variants', async () => {
    const page = await request(gateway!.getHttpServer())
      .get(paths[2] + '&tamanio=1')
      .expect(200);
    expect(page.body.total).toBe(2);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].product_id).toBe(id(10));
    for (const [productId, slug] of [
      [11, 'draft'],
      [12, 'inactive'],
      [13, 'empty'],
    ] as const) {
      for (const path of [
        `/api/v1/productos/${id(productId)}?canal=MARKETPLACE`,
        `/api/v1/productos/por-slug/${slug}?canal=MARKETPLACE`,
      ])
        await request(gateway!.getHttpServer()).get(path).expect(404);
    }
    const parent = await request(gateway!.getHttpServer())
      .get('/api/v1/productos/por-slug/parent?canal=MARKETPLACE')
      .expect(200);
    expect(parent.body.variants.map((row: { sku: string }) => row.sku)).toEqual(
      ['ACTIVE-VARIANT'],
    );
    await request(gateway!.getHttpServer())
      .get(paths[2] + '&estado=BORRADOR')
      .expect(403);
  });

  it('denies anonymous writes, private/admin reads and preserves valid JWT authorization in Phase 1', async () => {
    for (const path of [
      `/api/v1/productos/${id(10)}/preparacion`,
      '/api/v1/marcas/administracion',
    ])
      await request(gateway!.getHttpServer()).get(path).expect(401);
    await request(gateway!.getHttpServer())
      .get('/api/v1/productos/skus/SIMPLE/contexto')
      .expect(404);
    await request(catalog!.getHttpServer())
      .get('/api/v1/productos/skus/SIMPLE/contexto')
      .expect(401);
    for (const path of [
      '/api/v1/productos',
      '/api/v1/categorias',
      '/api/v1/marcas',
    ])
      await request(gateway!.getHttpServer()).post(path).send({}).expect(401);
    const human = token({
      tipo: 'acceso',
      sub: id(90),
      roles: ['GESTOR_COMERCIAL'],
    });
    await request(gateway!.getHttpServer())
      .get(`/api/v1/categorias/${id(1)}`)
      .set('Authorization', 'Bearer ' + human)
      .expect(200);
    await request(gateway!.getHttpServer())
      .get(`/api/v1/productos/${id(10)}/variantes`)
      .set('Authorization', 'Bearer ' + human)
      .expect(200);
    // A valid authenticated mutation reaches normal validation, rather than a mode-wide 403.
    await request(gateway!.getHttpServer())
      .post('/api/v1/categorias')
      .set('Authorization', 'Bearer ' + human)
      .send({})
      .expect(400);
  });

  it('never falls back to anonymous access for invalid, expired, wrong-issuer/audience/signature or underprivileged JWTs', async () => {
    const cases: Array<[string, number]> = [
      ['invalid', 401],
      [token({ exp: 1 }), 401],
      [token({ iss: issuer + '-wrong' }), 401],
      [token({ aud: 'wrong-api' }), 401],
      [token({}, true), 401],
      [token({ scope: 'wrong:scope' }), 403],
      [token({ sub: 'unapproved-client' }), 403],
      [token({ tipo: 'acceso', sub: id(90), roles: ['LECTOR_EXTERNO'] }), 403],
    ];
    for (const [jwt, status] of cases) {
      for (const [app, path] of [
        [gateway!, paths[3]],
        [catalog!, paths[4]],
        [taxonomy!, paths[0]],
      ] as const) {
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer ' + jwt)
          .expect(status);
      }
    }
  });

  it('fails closed if Taxonomy public approval is absent, without opening its private detail routes', async () => {
    await restart('PUBLIC_READ_ONLY', true, false);
    for (const path of [paths[3], paths[4]])
      await request(gateway!.getHttpServer()).get(path).expect(503);
    await request(taxonomy!.getHttpServer())
      .get(`/api/v1/marcas/${id(3)}`)
      .expect(401);
  });

  it('requires independent Gateway approval even when both providers are public', async () => {
    await restart('PUBLIC_READ_ONLY', true, true, false);
    for (const path of paths)
      await request(gateway!.getHttpServer()).get(path).expect(401);
    await request(catalog!.getHttpServer()).get(paths[3]).expect(200);
  });

  it('restores the five original JWT contracts by configuration/restart, with no application edits', async () => {
    await restart('G7_AUTHENTICATED');
    for (const path of paths) {
      await request(gateway!.getHttpServer()).get(path).expect(401);
      await request(gateway!.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer ' + token())
        .expect(200);
    }
    await request(catalog!.getHttpServer()).get(paths[3]).expect(401);
    await request(taxonomy!.getHttpServer()).get(paths[0]).expect(401);
  });
  it('leaves persisted business rows and Inbox/Outbox unchanged after the read and rejection scenarios', () => {
    expect(snapshot()).toBe(persistedBefore);
  });
});
