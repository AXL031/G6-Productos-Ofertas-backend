import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { CombosSvcModule } from '../src/combos-svc.module.js';
import { CombosProblemFilter } from '../src/http/combos-problem.filter.js';
import { combosCorrelationMiddleware } from '../src/http/combos-correlation.middleware.js';
import { CombosDatabase } from '../src/persistence/combos.database.js';
import {
  CatalogComponentDeactivatedError,
  CombosRepository,
} from '../src/persistence/combos.repository.js';

const isolatedHarnessEnabled =
  process.env.COMBOS_TEST_EPHEMERAL === '1' &&
  process.env.COMBOS_TEST_DATABASE_URL === 'harness-owned';

describe.skipIf(!isolatedHarnessEnabled)(
  'Combos PostgreSQL 17 + HTTP integration (isolated harness only)',
  () => {
    let app: INestApplication;
    let catalog: Server;
    let pricing: Server;
    let identity: Server;
    let issuer: string;
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'combos-postgres-local-key';
    let issuedServiceTokens = 0;
    let catalogOrigin: string;
    let pricingOrigin: string;
    let catalogStatus = 200;
    let pricingStatus = 200;
    const created: string[] = [];
    const backup: Record<string, string | undefined> = {};
    const keys = [
      'PGHOST',
      'PGPORT',
      'PGDATABASE',
      'PGUSER',
      'PGPASSWORD',
      'PGSSLMODE',
      'PGSSLROOTCERT',
      'COMBOS_RESTRICTED_DEMO_ENABLED',
      'G6_SECURITY_MODE',
      'COMBOS_ALLOWED_CLIENTS_COMBOS_READ',
      'COMBOS_TEST_DEFAULT_AUTH',
      'COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED',
      'COMBOS_RESTRICTED_DEMO_GATEWAY_IPS',
      'COMBOS_CATALOG_URL',
      'COMBOS_PRICING_URL',
      'COMBOS_CATALOG_CONTEXT_AUTHORIZED',
      'COMBOS_CATALOG_SERVICE_BEARER',
      'COMBOS_PRICING_SERVICE_BEARER',
      'COMBOS_G7_TOKEN_URL',
      'COMBOS_G7_CLIENT_SECRET',
      'COMBOS_ALLOWED_ROLES_LISTAR_COMBOS_ADMIN',
      'COMBOS_ALLOWED_ROLES_CREAR_COMBO',
      'COMBOS_ALLOWED_ROLES_OBTENER_COMBO',
      'COMBOS_ALLOWED_ROLES_ACTUALIZAR_COMBO',
      'COMBOS_ALLOWED_ROLES_DESACTIVAR_COMBO',
      'COMBOS_ALLOWED_ROLES_CONSULTAR_DISPONIBILIDAD_COMBO',
      'SECURITY_ISSUER',
      'SECURITY_DISCOVERY_URL',
      'SECURITY_JWKS_URL',
    ];
    const skuContext = (sku: string) => ({
      sku,
      productId: '00000000-0000-4000-8000-000000000020',
      isVariant: false,
      active: true,
      eligible: true,
    });
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const makeToken = (
      kind: 'acceso' | 'servicio' = 'acceso',
      scope?: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer,
        sub:
          kind === 'servicio'
            ? 'modulo-productos'
            : '00000000-0000-4000-8000-000000000010',
        tipo: kind,
        aud: ['api-productos'],
        ...(kind === 'acceso' ? { roles: ['admin'] } : { scope }),
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        ...overrides,
      };
      const unsigned = `${encode({ alg: 'RS256', kid })}.${encode(claims)}`;
      return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keyPair.privateKey).toString('base64url')}`;
    };

    beforeAll(async () => {
      for (const key of keys) backup[key] = process.env[key];
      for (const key of keys.filter((name) =>
        name.startsWith('COMBOS_ALLOWED_ROLES_'),
      ))
        process.env[key] = 'admin';
      process.env.PGHOST = '127.0.0.1';
      process.env.PGSSLMODE = 'verify-full';
      process.env.PGSSLROOTCERT = process.env.COMBOS_TEST_CA!;
      process.env.COMBOS_RESTRICTED_DEMO_ENABLED = 'false';
      process.env.COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED = 'true';
      process.env.COMBOS_RESTRICTED_DEMO_GATEWAY_IPS =
        '127.0.0.1,::1,::ffff:127.0.0.1';
      process.env.COMBOS_CATALOG_CONTEXT_AUTHORIZED = 'true';
      process.env.COMBOS_CATALOG_SERVICE_BEARER = 'isolated-test-service-token';
      process.env.COMBOS_PRICING_SERVICE_BEARER = 'isolated-test-service-token';
      identity = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'public, max-age=60');
        if (req.url === '/.well-known/openid-configuration') {
          res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
          return;
        }
        if (req.url === '/jwks') {
          res.end(
            JSON.stringify({
              keys: [
                {
                  ...keyPair.publicKey.export({ format: 'jwk' }),
                  kid,
                  alg: 'RS256',
                  use: 'sig',
                },
              ],
            }),
          );
          return;
        }
        if (req.url === '/token' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk.toString();
          const form = new URLSearchParams(body);
          if (
            form.get('grant_type') !== 'client_credentials' ||
            form.get('client_id') !== 'modulo-productos' ||
            form.get('client_secret') !== 'isolated-secret'
          ) {
            res.writeHead(401).end('{}');
            return;
          }
          const scope = form.get('scope') ?? '';
          issuedServiceTokens += 1;
          res.end(
            JSON.stringify({
              accessToken: makeToken('servicio', scope),
              tokenType: 'Bearer',
              expiresIn: 600,
              scopes: [scope],
            }),
          );
          return;
        }
        res.writeHead(404).end('{}');
      });
      identity.listen(0, '127.0.0.1');
      await once(identity, 'listening');
      issuer = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;
      process.env.SECURITY_ISSUER = issuer;
      process.env.SECURITY_DISCOVERY_URL = `${issuer}/.well-known/openid-configuration`;
      process.env.SECURITY_JWKS_URL = `${issuer}/jwks`;
      process.env.COMBOS_G7_TOKEN_URL = `${issuer}/token`;
      process.env.COMBOS_G7_CLIENT_SECRET = 'isolated-secret';
      catalog = createServer((req, res) => {
        const sku = decodeURIComponent((req.url ?? '').split('/').at(-2) ?? '');
        const missing = sku === 'MISSING';
        const status = missing ? 404 : catalogStatus;
        res.writeHead(status, {
          'content-type': missing
            ? 'application/problem+json'
            : 'application/json',
        });
        res.end(
          JSON.stringify(
            missing
              ? {
                  title: 'SKU no encontrado',
                  status: 404,
                  code: 'SKU_NO_ENCONTRADO',
                }
              : {
                  ...skuContext(sku),
                  active: sku !== 'INACTIVE',
                  eligible: sku !== 'INELIGIBLE',
                },
          ),
        );
      });
      pricing = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const skus = url.pathname.includes('/skus/')
          ? [decodeURIComponent(url.pathname.split('/').at(-1)!)]
          : (url.searchParams.get('skus') ?? '').split(',');
        const item = (sku: string) => ({
          sku,
          precio_regular: 10.0,
          precio_oferta: 9.0,
          currency: 'PEN',
          channel_id: null,
          valid_from: '2026-01-01T00:00:00Z',
          valid_until: null,
          price_version: 1,
          vigencia_id: `validity-${sku}`,
          origen: 'PRODUCTO',
        });
        res.writeHead(pricingStatus, { 'content-type': 'application/json' });
        res.end(
          url.pathname.includes('/skus/')
            ? JSON.stringify(item(skus[0]!))
            : JSON.stringify({ items: skus.map(item) }),
        );
      });
      catalog.listen(0, '127.0.0.1');
      pricing.listen(0, '127.0.0.1');
      await Promise.all([
        once(catalog, 'listening'),
        once(pricing, 'listening'),
      ]);
      catalogOrigin = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
      pricingOrigin = `http://127.0.0.1:${(pricing.address() as AddressInfo).port}`;
      process.env.COMBOS_CATALOG_URL = catalogOrigin;
      process.env.COMBOS_PRICING_URL = pricingOrigin;
      const module = await Test.createTestingModule({
        imports: [CombosSvcModule],
      }).compile();
      app = module.createNestApplication();
      process.env.COMBOS_TEST_DEFAULT_AUTH = 'true';
      app.use((req, _res, next) => {
        if (
          !req.headers.authorization &&
          process.env.COMBOS_TEST_DEFAULT_AUTH === 'true'
        )
          req.headers.authorization = `Bearer ${makeToken()}`;
        next();
      });
      app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
      app.use(combosCorrelationMiddleware);
      app.useGlobalFilters(new CombosProblemFilter());
      await app.init();
    }, 30000);

    afterAll(async () => {
      await app?.close();
      await Promise.all([
        catalog &&
          new Promise<void>((resolve) => catalog.close(() => resolve())),
        pricing &&
          new Promise<void>((resolve) => pricing.close(() => resolve())),
        identity &&
          new Promise<void>((resolve) => identity.close(() => resolve())),
      ]);
      for (const key of keys) {
        if (backup[key] === undefined) delete process.env[key];
        else process.env[key] = backup[key]!;
      }
    });

    it('serves liveness and readiness only when PostgreSQL is available and TLS is verified', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
      await request(app.getHttpServer()).get('/ready').expect(200);
      const db = app.get(CombosDatabase);
      const result = await db.query((c) =>
        c.query(
          'SELECT ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
        ),
      );
      expect(result.rows[0]).toMatchObject({ ssl: true });
      expect(String(result.rows[0]?.version)).toMatch(/^TLSv1\.[23]$/);
      const tables = await db.query((c) =>
        c.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='combos' AND table_type='BASE TABLE' ORDER BY table_name",
        ),
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'combo_items',
        'combos',
        'component_projection',
        'inbox',
        'outbox',
      ]);
      const savedPort = process.env.PGPORT;
      process.env.PGPORT = '1';
      const disconnected = new CombosDatabase();
      expect(await disconnected.ready()).toBe(false);
      await expect(
        new CombosRepository(disconnected).list({ page: 1, size: 1 }),
      ).rejects.toMatchObject({ status: 503 });
      await disconnected.onModuleDestroy();
      process.env.PGPORT = savedPort;
    });

    it('creates, reads, paginates, updates with optimistic version, and deactivates persistently', async () => {
      const server = app.getHttpServer();
      const body = {
        nombre: 'Fixture combo',
        descripcion: null,
        componentes: [
          { sku: '000001', cantidad: 2 },
          { sku: '000002', cantidad: 1 },
        ],
        precioCombo: 17.0,
      };
      const createdResponse = await request(server)
        .post('/api/v1/combos')
        .set('X-Correlation-Id', '00000000-0000-4000-8000-000000000001')
        .send(body)
        .expect(201);
      const id = createdResponse.body.combo_id as string;
      created.push(id);
      expect(createdResponse.headers['x-correlation-id']).toBe(
        '00000000-0000-4000-8000-000000000001',
      );
      expect(createdResponse.body.components).toHaveLength(2);
      await request(server)
        .get('/api/v1/combos')
        .query({ pagina: 1, tamanio: 1 })
        .expect(200)
        .expect((r) => expect(r.body.meta.tamanio).toBe(1));
      await request(server)
        .get(`/api/v1/combos/${id}`)
        .expect(200)
        .expect((r) => expect(r.body.combo_id).toBe(id));
      await request(server)
        .get(`/api/v1/combos/${randomUUID()}`)
        .expect(404)
        .expect((r) => expect(r.body.code).toBe('COMBO_NO_ENCONTRADO'));
      await request(server)
        .patch(`/api/v1/combos/${id}`)
        .send({
          ...body,
          nombre: 'Updated',
          componentes: [
            { sku: '000003', cantidad: 3 },
            { sku: '000004', cantidad: 1 },
          ],
          version: 0,
        })
        .expect(200)
        .expect((r) => expect(r.body.version).toBe(1));
      await request(server)
        .patch(`/api/v1/combos/${id}`)
        .send({ ...body, version: 0 })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('VERSION_CONFLICT'));
      const db = app.get(CombosDatabase);
      await db.query(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            'DELETE FROM combos.combo_items WHERE combo_id=$1 AND sku=$2',
            [id, '000003'],
          );
          await expect(client.query('COMMIT')).rejects.toMatchObject({
            code: '23514',
          });
        } finally {
          await client.query('ROLLBACK');
        }
      });
      await db.query(async (client) => {
        await client.query('BEGIN');
        try {
          await expect(
            client.query(
              'INSERT INTO combos.combo_items(combo_id,sku,quantity) VALUES($1,$2,1)',
              [id, '000003'],
            ),
          ).rejects.toMatchObject({ code: '23505' });
        } finally {
          await client.query('ROLLBACK');
        }
      });
      const persistedComponents = await db.query((client) =>
        client.query(
          'SELECT sku,quantity FROM combos.combo_items WHERE combo_id=$1 ORDER BY sku',
          [id],
        ),
      );
      expect(persistedComponents.rows).toHaveLength(2);
      await request(server)
        .get(`/api/v1/combos/${id}/disponibilidad`)
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({
            verificable: false,
            cantidadInformativa: null,
            estadoActualizacion: 'INCOMPLETA',
          }),
        );
      await request(server)
        .post(`/api/v1/combos/${id}/desactivar`)
        .expect(200)
        .expect((r) => expect(r.body.status).toBe('INACTIVO'));
      const dbAgain = app.get(CombosDatabase);
      const once = await dbAgain.query((client) =>
        client.query('SELECT version FROM combos.combos WHERE id=$1', [id]),
      );
      await request(server).post(`/api/v1/combos/${id}/desactivar`).expect(200);
      const twice = await dbAgain.query((client) =>
        client.query('SELECT version FROM combos.combos WHERE id=$1', [id]),
      );
      expect(twice.rows[0]?.version).toBe(once.rows[0]?.version);
      await request(server)
        .get(`/api/v1/combos/${id}`)
        .expect(200)
        .expect((r) => expect(r.body.status).toBe('INACTIVO'));
    });

    it('reconciles historical SKU deactivation and serializes current deactivation against creation', async () => {
      const database = app.get(CombosDatabase);
      const repository = app.get(CombosRepository);
      const staleSku = `REACTIVATED-${randomUUID()}`;
      const productId = randomUUID();
      const oldDate = new Date(Date.now() - 60000).toISOString();
      const staleInput = {
        messageId: randomUUID(),
        handler: 'combos.catalog.sku.deactivated',
        eventName: 'catalog.sku.deactivated',
        correlationId: randomUUID(),
        operationId: null,
        payload: {
          name: 'catalog.sku.deactivated',
          data: { sku: staleSku, product_id: productId, changed_at: oldDate },
        },
        disposition: 'PROCESSED' as const,
        sku: staleSku,
        changedAt: oldDate,
      };
      expect(await repository.processEvent(staleInput)).toBe('PROCESSED');
      expect(await repository.processEvent(staleInput)).toBe('DUPLICATE');
      const comboId = await repository.create({
        name: 'Reactivated SKU',
        description: null,
        price: '5.00',
        currency: 'PEN',
        components: [
          {
            sku: staleSku,
            quantity: 1,
            productId,
            catalogObservedAt: new Date().toISOString(),
          },
          {
            sku: `${staleSku}-2`,
            quantity: 1,
            productId,
            catalogObservedAt: new Date().toISOString(),
          },
        ],
      });
      created.push(comboId);
      const projection = await repository.projections(comboId);
      expect(
        projection.every((item) => item.catalogDeactivated === false),
      ).toBe(true);

      const racingSku = `RACE-${randomUUID()}`;
      const changedAt = new Date(Date.now() - 30000).toISOString();
      let unlock!: () => void;
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => (locked = resolve));
      const hold = new Promise<void>((resolve) => (unlock = resolve));
      const lockTransaction = database.query(async (client) => {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(840084)');
        locked();
        await hold;
        await client.query('COMMIT');
      });
      await acquired;
      const event = repository.processEvent({
        messageId: randomUUID(),
        handler: 'combos.catalog.sku.deactivated',
        eventName: 'catalog.sku.deactivated',
        correlationId: randomUUID(),
        operationId: null,
        payload: {
          name: 'catalog.sku.deactivated',
          data: {
            sku: racingSku,
            product_id: productId,
            changed_at: changedAt,
          },
        },
        disposition: 'PROCESSED',
        sku: racingSku,
        changedAt,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const creation = repository.create({
        name: 'Concurrent stale create',
        description: null,
        price: '5.00',
        currency: 'PEN',
        components: [
          {
            sku: racingSku,
            quantity: 1,
            productId,
            catalogObservedAt: new Date(Date.now() - 60000).toISOString(),
          },
          {
            sku: `${racingSku}-2`,
            quantity: 1,
            productId,
            catalogObservedAt: new Date().toISOString(),
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      unlock();
      await lockTransaction;
      await expect(event).resolves.toBe('PROCESSED');
      await expect(creation).rejects.toBeInstanceOf(
        CatalogComponentDeactivatedError,
      );

      let providerStarted!: () => void;
      let releaseProvider!: () => void;
      const started = new Promise<void>(
        (resolve) => (providerStarted = resolve),
      );
      const blockedProvider = new Promise<void>(
        (resolve) => (releaseProvider = resolve),
      );
      const productEvent = repository.processEvent({
        messageId: randomUUID(),
        handler: 'combos.catalog.product.deactivated',
        eventName: 'catalog.product.deactivated',
        correlationId: randomUUID(),
        operationId: null,
        payload: {
          name: 'catalog.product.deactivated',
          data: {
            product_id: randomUUID(),
            product_version: 2,
            changed_at: new Date().toISOString(),
          },
        },
        disposition: 'PROCESSED',
        resolveProductSkus: async () => {
          providerStarted();
          await blockedProvider;
          return [];
        },
      });
      await started;
      const independentCreate = repository.create({
        name: 'Write while Catalog is slow',
        description: null,
        price: '5.00',
        currency: 'PEN',
        components: [
          {
            sku: `SLOW-${randomUUID()}`,
            quantity: 1,
            productId: randomUUID(),
            catalogObservedAt: new Date().toISOString(),
          },
          {
            sku: `SLOW-${randomUUID()}`,
            quantity: 1,
            productId: randomUUID(),
            catalogObservedAt: new Date().toISOString(),
          },
        ],
      });
      try {
        await expect(
          Promise.race([
            independentCreate,
            new Promise<never>((_resolve, reject) =>
              setTimeout(
                () => reject(new Error('WRITE_BLOCKED_BY_PROVIDER')),
                2000,
              ),
            ),
          ]),
        ).resolves.toBeTruthy();
      } finally {
        releaseProvider();
      }
      await expect(productEvent).resolves.toBe('PROCESSED');
    }, 30000);

    it('rejects invalid, insufficient and repeated components without persistence', async () => {
      const server = app.getHttpServer();
      const base = { nombre: 'Invalid', precioCombo: 10 };
      await request(server)
        .post('/api/v1/combos')
        .send({ ...base, componentes: [{ sku: '1', cantidad: 1 }] })
        .expect(422)
        .expect((r) =>
          expect(r.body.code).toBe('COMBO_COMPONENTES_INSUFICIENTES'),
        );
      await request(server)
        .post('/api/v1/combos')
        .send({
          ...base,
          componentes: [
            { sku: '1', cantidad: 1 },
            { sku: '1', cantidad: 2 },
          ],
        })
        .expect(422)
        .expect((r) => expect(r.body.code).toBe('COMBO_COMPONENTE_DUPLICADO'));
      await request(server)
        .post('/api/v1/combos')
        .send({
          ...base,
          componentes: [
            { sku: '1', cantidad: 0 },
            { sku: '2', cantidad: 1 },
          ],
        })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('VALIDACION'));
      await request(server)
        .post('/api/v1/combos')
        .send({
          ...base,
          precioCombo: 18,
          componentes: [
            { sku: '1', cantidad: 1 },
            { sku: '2', cantidad: 1 },
          ],
        })
        .expect(422)
        .expect((r) => expect(r.body.code).toBe('COMBO_PRECIO_INVALIDO'));
    });

    it('maps authoritative Catalog and Pricing rejection/failure without turning provider errors into missing SKUs', async () => {
      const server = app.getHttpServer();
      const body = {
        nombre: 'Provider case',
        componentes: [
          { sku: '1', cantidad: 1 },
          { sku: '2', cantidad: 1 },
        ],
        precioCombo: 10,
      };
      const metadataCombo = await request(server)
        .post('/api/v1/combos')
        .send(body)
        .expect(201);
      const metadataId = metadataCombo.body.combo_id as string;
      catalogStatus = 503;
      await request(server)
        .patch(`/api/v1/combos/${metadataId}`)
        .send({ nombre: 'Metadata only' })
        .expect(200);
      catalogStatus = 200;
      for (const sku of ['MISSING', 'INACTIVE', 'INELIGIBLE']) {
        const response = await request(server)
          .post('/api/v1/combos')
          .send({
            ...body,
            componentes: [
              { sku, cantidad: 1 },
              { sku: `${sku}-2`, cantidad: 1 },
            ],
          })
          .expect(404);
        expect(response.body.code).toBe('SKU_NO_ENCONTRADO');
      }
      catalogStatus = 403;
      await request(server)
        .post('/api/v1/combos')
        .send(body)
        .expect(503)
        .expect((r) => expect(r.body.code).toBe('SERVICIO_NO_DISPONIBLE'));
      catalogStatus = 200;
      pricingStatus = 503;
      await request(server)
        .post('/api/v1/combos')
        .send(body)
        .expect(503)
        .expect((r) => expect(r.body.code).toBe('SERVICIO_NO_DISPONIBLE'));
      pricingStatus = 200;
    });

    it('keeps JWT default closed and returns correlated Problem Details for invalid auth/header', async () => {
      process.env.COMBOS_TEST_DEFAULT_AUTH = 'false';
      process.env.COMBOS_RESTRICTED_DEMO_ENABLED = 'false';
      await request(app.getHttpServer())
        .get('/api/v1/combos')
        .expect(401)
        .expect((r) => expect(r.body.code).toBe('TOKEN_INVALIDO'));
      process.env.COMBOS_RESTRICTED_DEMO_ENABLED = 'true';
      await request(app.getHttpServer())
        .get('/api/v1/combos')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401)
        .expect((r) => expect(r.body.code).toBe('TOKEN_INVALIDO'));
      process.env.COMBOS_RESTRICTED_DEMO_GATEWAY_IPS = '203.0.113.10';
      await request(app.getHttpServer())
        .get('/api/v1/combos')
        .set('X-Forwarded-For', '203.0.113.10')
        .set('X-Real-IP', '203.0.113.10')
        .expect(403)
        .expect((r) => expect(r.body.code).toBe('SCOPE_INSUFICIENTE'));
      process.env.COMBOS_RESTRICTED_DEMO_GATEWAY_IPS =
        '127.0.0.1,::1,::ffff:127.0.0.1';
      await request(app.getHttpServer())
        .get('/api/v1/combos')
        .set('X-Correlation-Id', 'invalid')
        .expect(400)
        .expect((r) => {
          expect(r.body).toMatchObject({ status: 400, code: 'VALIDACION' });
          expect(r.headers['x-correlation-id']).toBe(r.body.correlationId);
        });
      process.env.COMBOS_TEST_DEFAULT_AUTH = 'true';
    });

    it('verifies RS256 users and denies unauthenticated/service identities for all six operations', async () => {
      const roleKeys = [
        'COMBOS_ALLOWED_ROLES_LISTAR_COMBOS_ADMIN',
        'COMBOS_ALLOWED_ROLES_CREAR_COMBO',
        'COMBOS_ALLOWED_ROLES_OBTENER_COMBO',
        'COMBOS_ALLOWED_ROLES_ACTUALIZAR_COMBO',
        'COMBOS_ALLOWED_ROLES_DESACTIVAR_COMBO',
        'COMBOS_ALLOWED_ROLES_CONSULTAR_DISPONIBILIDAD_COMBO',
      ];
      process.env.COMBOS_RESTRICTED_DEMO_ENABLED = 'false';
      process.env.COMBOS_TEST_DEFAULT_AUTH = 'false';
      for (const key of roleKeys) delete process.env[key];
      const repository = app.get(CombosRepository);
      const comboId = await repository.create({
        name: 'JWT integration',
        description: null,
        price: '5.00',
        currency: 'PEN',
        components: [
          {
            sku: 'JWT-1',
            quantity: 1,
            productId: 'jwt-product',
            catalogObservedAt: new Date().toISOString(),
          },
          {
            sku: 'JWT-2',
            quantity: 1,
            productId: 'jwt-product',
            catalogObservedAt: new Date().toISOString(),
          },
        ],
      });
      created.push(comboId);
      const calls = [
        () => request(app.getHttpServer()).get('/api/v1/combos'),
        () =>
          request(app.getHttpServer())
            .post('/api/v1/combos')
            .send({
              nombre: 'JWT create',
              metadata: { ignored: true },
              componentes: [
                { sku: 'JWT-A', cantidad: 1, extension: 'ignored' },
                { sku: 'JWT-B', cantidad: 1, extension: 'ignored' },
              ],
              precioCombo: 5,
            }),
        () => request(app.getHttpServer()).get(`/api/v1/combos/${comboId}`),
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/combos/${comboId}`)
            .send({ nombre: 'JWT updated', version: 0 }),
        () =>
          request(app.getHttpServer()).post(
            `/api/v1/combos/${comboId}/desactivar`,
          ),
        () =>
          request(app.getHttpServer()).get(
            `/api/v1/combos/${comboId}/disponibilidad`,
          ),
      ];
      for (const call of calls) {
        await call().expect(401);
        await call().set('Authorization', 'Bearer malformed').expect(401);
        await call()
          .set(
            'Authorization',
            `Bearer ${makeToken('servicio', 'combos:leer')}`,
          )
          .expect(403);
        await call()
          .set(
            'Authorization',
            `Bearer ${makeToken('acceso', undefined, { roles: ['inventario:admin'] })}`,
          )
          .expect(403);
        await call().set('Authorization', `Bearer ${makeToken()}`).expect(403);
      }
      for (const key of roleKeys) process.env[key] = 'combos:admin';
      const adminAuth = `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`;
      await request(app.getHttpServer())
        .post('/api/v1/combos')
        .set('Authorization', adminAuth)
        .send({
          nombre: 'Missing price',
          componentes: [
            { sku: 'A', cantidad: 1 },
            { sku: 'B', cantidad: 1 },
          ],
        })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/combos')
        .set('Authorization', adminAuth)
        .send({
          nombre: 'Invalid quantity',
          precioCombo: 1,
          componentes: [
            { sku: 'A', cantidad: '1' },
            { sku: 'B', cantidad: 1 },
          ],
        })
        .expect(400);
      await calls[0]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(200);
      await calls[1]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(201);
      await calls[2]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(200);
      await calls[3]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(200);
      await calls[4]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(200);
      await calls[5]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(200);
      await calls[5]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(200);
      process.env.G6_SECURITY_MODE = 'PUBLIC_READ_ONLY';
      process.env.COMBOS_ALLOWED_CLIENTS_COMBOS_READ = 'modulo-productos';
      await request(app.getHttpServer()).get('/api/v1/combos').expect(401);
      await calls[2]!()
        .set(
          'Authorization',
          `Bearer ${makeToken('acceso', undefined, { roles: ['combos:admin'] })}`,
        )
        .expect(200);
      await calls[2]!()
        .set('Authorization', `Bearer ${makeToken('servicio', 'combos:leer')}`)
        .expect(200);
      await calls[4]!()
        .set('Authorization', `Bearer ${makeToken('servicio', 'combos:leer')}`)
        .expect(403);
      process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
      delete process.env.COMBOS_ALLOWED_CLIENTS_COMBOS_READ;
      expect(issuedServiceTokens).toBeGreaterThan(0);
      for (const key of roleKeys) process.env[key] = 'admin';
      process.env.COMBOS_TEST_DEFAULT_AUTH = 'true';
    }, 30000);

    it('rolls back parent and child rows on component constraint failure', async () => {
      const db = app.get(CombosDatabase);
      await db.query((c) =>
        c.query(
          "CREATE FUNCTION combos.it_fail_component() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.sku='ROLLBACK-FAIL' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER it_fail_component BEFORE INSERT ON combos.combo_items FOR EACH ROW EXECUTE FUNCTION combos.it_fail_component()",
        ),
      );
      const before = await db.query((c) =>
        c.query('SELECT count(*)::int AS n FROM combos.combos'),
      );
      await request(app.getHttpServer())
        .post('/api/v1/combos')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({
          nombre: 'Rollback',
          componentes: [
            { sku: 'ROLLBACK-FAIL', cantidad: 1 },
            { sku: 'OTHER', cantidad: 1 },
          ],
          precioCombo: 10,
        })
        .expect(500);
      const after = await db.query((c) =>
        c.query('SELECT count(*)::int AS n FROM combos.combos'),
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      await db.query((c) =>
        c.query(
          'DROP TRIGGER it_fail_component ON combos.combo_items; DROP FUNCTION combos.it_fail_component()',
        ),
      );
    });
  },
);
