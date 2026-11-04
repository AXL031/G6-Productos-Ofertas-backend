import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { CombosSvcModule } from '../src/combos-svc.module.js';
import { CombosProblemFilter } from '../src/http/combos-problem.filter.js';
import { combosCorrelationMiddleware } from '../src/http/combos-correlation.middleware.js';
import { CombosDatabase } from '../src/persistence/combos.database.js';
import { CombosRepository } from '../src/persistence/combos.repository.js';

const isolatedHarnessEnabled =
  process.env.COMBOS_TEST_EPHEMERAL === '1' &&
  process.env.COMBOS_TEST_DATABASE_URL === 'harness-owned';

describe.skipIf(!isolatedHarnessEnabled)(
  'Combos PostgreSQL 17 + HTTP integration (isolated harness only)',
  () => {
    let app: INestApplication;
    let catalog: Server;
    let pricing: Server;
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
      'COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED',
      'COMBOS_RESTRICTED_DEMO_GATEWAY_IPS',
      'COMBOS_CATALOG_URL',
      'COMBOS_PRICING_URL',
      'COMBOS_CATALOG_CONTEXT_AUTHORIZED',
      'COMBOS_CATALOG_SERVICE_BEARER',
      'COMBOS_PRICING_SERVICE_BEARER',
    ];
    const skuContext = (sku: string) => ({
      sku,
      productId: 'fixture-product',
      isVariant: false,
      active: true,
      eligible: true,
    });

    beforeAll(async () => {
      for (const key of keys) backup[key] = process.env[key];
      process.env.PGHOST = '127.0.0.1';
      process.env.PGSSLMODE = 'verify-full';
      process.env.PGSSLROOTCERT = process.env.COMBOS_TEST_CA!;
      process.env.COMBOS_RESTRICTED_DEMO_ENABLED = 'true';
      process.env.COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED = 'true';
      process.env.COMBOS_RESTRICTED_DEMO_GATEWAY_IPS =
        '127.0.0.1,::1,::ffff:127.0.0.1';
      process.env.COMBOS_CATALOG_CONTEXT_AUTHORIZED = 'true';
      process.env.COMBOS_CATALOG_SERVICE_BEARER = 'isolated-test-service-token';
      process.env.COMBOS_PRICING_SERVICE_BEARER = 'isolated-test-service-token';
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
      await request(server)
        .get(`/api/v1/combos/${id}`)
        .expect(200)
        .expect((r) => expect(r.body.status).toBe('INACTIVO'));
    });

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
        .send({ nombre: 'Metadata only', version: 0 })
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
    });

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
