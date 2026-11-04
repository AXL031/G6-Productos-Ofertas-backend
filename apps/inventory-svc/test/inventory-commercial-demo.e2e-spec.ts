import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { InventorySvcModule } from '../src/inventory-svc.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { InventoryWorkersService } from '../src/workers/inventory-workers.service.js';
import { InventoryAuthGuard } from '../src/auth/inventory-auth.guard.js';
import { ProblemDetailsFilter } from '../src/errors/problem-details.filter.js';
import { InMemoryDatabaseMock } from './in-memory-database.mock.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from './crypto-test-token.helper.js';

const commercial = '/api/v1/inventario/disponibilidad/comercial';
const verify = `${commercial}/verificar`;
const sku = 'NIK-REV7-NEG-41';
const location = '9129b578-631e-1735-8427-b683fb524380';
const channels = ['MARKETPLACE', 'CHATBOT', 'RETAIL'] as const;
const input = (channel: string = 'MARKETPLACE', quantity = 2) => ({
  channel_id: channel,
  fulfillment: { mode: 'ENVIO_DOMICILIO' },
  lines: [{ sku, quantity }],
});
const artifact = process.env.INVENTORY_GATEWAY_ARTIFACT_DIR;

describe('Inventory comercial demo — HTTP real, persistencia de prueba (#25/#100)', () => {
  let app: INestApplication;
  let db: InMemoryDatabaseMock;
  let origin: string;
  let incoming: Request[];
  const state = () =>
    structuredClone({
      stock: db.stockBalance,
      reservations: db.reservations,
      operations: db.operations,
      kardex: db.kardex,
      outbox: db.outbox,
      inbox: db.inbox,
      routes: db.commercialRoutes,
    });
  beforeAll(async () => {
    vi.stubEnv('RABBITMQ_URL', undefined);
    db = new InMemoryDatabaseMock();
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    })
      .overrideProvider(InventoryWorkersService)
      .useValue({})
      .compile();
    module.get(DatabaseService).setCustomService(db);
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.getHttpAdapter().getInstance().set('trust proxy', true); // Incluso si otro componente lo activara.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      incoming.push(req);
      next();
    });
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    db.seedDefaults();
    incoming = [];
    vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'true');
    vi.stubEnv('INVENTORY_DEMO_GATEWAY_IPS', '127.0.0.1');
    vi.stubEnv('G7_JWT_ISSUER', undefined);
    vi.stubEnv('G7_JWT_PUBLIC_KEY', undefined);
    vi.stubEnv('JWT_PUBLIC_KEY', undefined);
    InventoryAuthGuard.setTrustedPublicKey(null);
    db.commercialRoutes.push(
      ...channels.map((channel_id, index) => ({
        id: `route-${index}`,
        channel_id,
        mode: 'ENVIO_DOMICILIO',
        fulfillment_ref: 'LIMA',
        location_id: location,
        active: true,
      })),
    );
  });
  afterAll(async () => {
    await app?.close();
    InventoryAuthGuard.setTrustedPublicKey(null);
    vi.unstubAllEnvs();
  });

  it.each(channels)(
    'consulta y verifica %s sin JWT, sin identidad ni efectos',
    async (channel) => {
      const before = state();
      const transaction = vi.spyOn(db, 'transaction');
      const get = await request(origin)
        .get(`${commercial}?skus=${sku}&canal=${channel}`)
        .expect(200);
      expect(get.body).toEqual({ items: [{ sku, status: 'DISPONIBLE' }] });
      const post = await request(origin)
        .post(verify)
        .send(input(channel))
        .expect(200);
      expect(post.body).toMatchObject({
        binding: false,
        items: [{ sku, result: 'SUFICIENTE', requested_quantity: 2 }],
      });
      expect(JSON.stringify([get.body, post.body])).not.toMatch(
        /on_hand|reserved|blocked|available|location_id|stock_version/,
      );
      for (const req of incoming) {
        expect('user' in req).toBe(false);
        expect('clientId' in req).toBe(false);
      }
      expect(state()).toEqual(before);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('sin mapeo devuelve INDETERMINADO y no asume un canal autenticado', async () => {
    db.commercialRoutes = [];
    const res = await request(origin)
      .post(verify)
      .send(input('RETAIL'))
      .expect(200);
    expect(res.body.items[0].result).toBe('INDETERMINADO');
  });

  it('no suma ubicaciones para satisfacer una cantidad que ninguna cubre', async () => {
    const res = await request(origin)
      .post(verify)
      .send(input('MARKETPLACE', 20))
      .expect(200);
    expect(res.body.items[0].result).toBe('INSUFICIENTE');
    db.commercialRoutes.push({
      id: 'ambigua',
      channel_id: 'MARKETPLACE',
      mode: 'ENVIO_DOMICILIO',
      fulfillment_ref: 'LIMA_OTRO',
      location_id: 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485',
      active: true,
    });
    const ambiguous = await request(origin)
      .post(verify)
      .send(input())
      .expect(200);
    expect(ambiguous.body.items[0].result).toBe('INDETERMINADO');
  });

  it('con flag apagado restaura JWT y correspondencia canal/cliente', async () => {
    vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'false');
    await request(origin)
      .get(`${commercial}?skus=${sku}&canal=MARKETPLACE`)
      .expect(401);
    await request(origin).post(verify).send(input()).expect(401);
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
    vi.stubEnv('G7_JWT_ISSUER', TEST_ISSUER);
    const token = createCryptographicJwt({
      clientId: 'modulo-marketplace',
      scope: 'inventario:disponibilidad:leer',
    });
    await request(origin)
      .get(`${commercial}?skus=${sku}&canal=MARKETPLACE`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(origin)
      .post(verify)
      .set('Authorization', `Bearer ${token}`)
      .send(input())
      .expect(200);
    await request(origin)
      .post(verify)
      .set('Authorization', `Bearer ${token}`)
      .send(input('RETAIL'))
      .expect(403);
  });

  it('rechaza conexión fuera de allowlist pese a headers o trust proxy', async () => {
    vi.stubEnv('INVENTORY_DEMO_GATEWAY_IPS', '192.0.2.10');
    await request(origin)
      .get(`${commercial}?skus=${sku}&canal=MARKETPLACE`)
      .set('X-Forwarded-For', '192.0.2.10')
      .set('Forwarded', 'for=192.0.2.10')
      .set('X-Inventory-Demo', 'true')
      .expect(401);
  });

  it('mantiene denegadas lecturas privadas y escrituras sin JWT', async () => {
    const before = state();
    for (const path of [
      '/disponibilidad?skus=SKU',
      '/dashboard',
      '/umbrales',
      '/traslados',
      `/operaciones/${randomUUID()}`,
    ])
      await request(origin).get(`/api/v1/inventario${path}`).expect(401);
    for (const path of [
      '/reservas',
      '/reintegros',
      '/incidencias',
      `/reservas/${randomUUID()}/confirmar`,
      `/reservas/${randomUUID()}/liberar`,
    ])
      await request(origin)
        .post(`/api/v1/inventario${path}`)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(401);
    await request(origin)
      .put('/api/v1/inventario/umbrales/global')
      .send({})
      .expect(401);
    expect(state()).toEqual(before);
  });

  it.each([
    { body: input('VENTAS'), status: 400, code: 'VALIDACION' },
    { body: input('MARKETPLACE', 0), status: 400, code: 'VALIDACION' },
    {
      body: { ...input(), fulfillment: { mode: 'INVALIDO' } },
      status: 422,
      code: 'CONTEXTO_ABASTECIMIENTO_INVALIDO',
    },
  ])(
    'demo conserva validación de dominio: $code/$status',
    async ({ body, status, code }) => {
      const before = state();
      const res = await request(origin).post(verify).send(body).expect(status);
      expect(res.body.code).toBe(code);
      expect(state()).toEqual(before);
    },
  );

  it('una caída DB devuelve 503 sanitizado y la consulta siguiente se recupera', async () => {
    vi.spyOn(db, 'query').mockRejectedValueOnce(
      Object.assign(new Error('host-privado-sintetico'), {
        code: 'ECONNREFUSED',
      }),
    );
    const res = await request(origin)
      .get(`${commercial}?skus=${sku}&canal=MARKETPLACE`)
      .expect(503);
    expect(res.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    expect(JSON.stringify(res.body)).not.toContain('host-privado');
    await request(origin)
      .get(`${commercial}?skus=${sku}&canal=MARKETPLACE`)
      .expect(200);
  });

  describe.skipIf(!artifact)(
    'Gateway #107/PR #130 en proceso separado — integración HTTP',
    () => {
      let child: ChildProcess;
      let gateway: string;
      beforeAll(async () => {
        const directory = resolve(artifact!);
        expect(
          JSON.parse(readFileSync(join(directory, 'source.json'), 'utf8')).sha,
        ).toBe('32153bffb35daa8761272c7b55fe23dc1df70007');
        child = fork(join(directory, 'gateway.entry.mjs'), [], {
          cwd: directory,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: {
            SystemRoot: process.env.SystemRoot,
            PATH: process.env.PATH,
            GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
            GATEWAY_INVENTORY_SVC_URL: origin,
          },
        });
        const port = await new Promise<number>((resolvePort, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Gateway no inició en 10 s')),
            10000,
          );
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('Gateway terminó antes de iniciar'));
          });
          child.once('message', (message: unknown) => {
            clearTimeout(timer);
            if (
              !message ||
              typeof message !== 'object' ||
              !('port' in message) ||
              typeof message.port !== 'number'
            )
              reject(new Error('Puerto inválido'));
            else resolvePort(message.port);
          });
        });
        gateway = `http://127.0.0.1:${port}`;
      }, 15000);
      afterAll(async () => {
        if (!child || child.exitCode !== null) return;
        const exited = once(child, 'exit');
        const timer = setTimeout(() => child.kill(), 3000);
        child.send('stop');
        await exited;
        clearTimeout(timer);
      });

      it.each(channels)(
        'Gateway → Inventory real consulta y verifica %s sin reenviar Authorization',
        async (channel) => {
          const before = state();
          const correlation = randomUUID();
          const get = await request(gateway)
            .get(`${commercial}?skus=${sku}&canal=${channel}`)
            .set('X-Correlation-Id', correlation)
            .set('Authorization', 'Bearer token-invalido-sintetico')
            .expect(200);
          expect(get.headers['x-correlation-id']).toBe(correlation);
          expect(get.body).toEqual({ items: [{ sku, status: 'DISPONIBLE' }] });
          const post = await request(gateway)
            .post(verify)
            .send(input(channel))
            .expect(200);
          expect(post.body).toMatchObject({
            binding: false,
            items: [{ result: 'SUFICIENTE' }],
          });
          expect(incoming).toHaveLength(2);
          for (const req of incoming) {
            expect(req.headers.authorization).toBeUndefined();
            expect('clientId' in req).toBe(false);
            expect('user' in req).toBe(false);
          }
          expect(state()).toEqual(before);
        },
      );

      it('Gateway rechaza rutas/métodos desconocidos y preserva la denegación de una lectura privada', async () => {
        await request(gateway).get('/api/v1/inventario/no-existe').expect(404);
        await request(gateway).put(commercial).send({}).expect(404);
        await request(gateway)
          .get('/api/v1/inventario/disponibilidad?skus=SKU')
          .expect(401);
      });

      it('flag de Inventory apagado impide la consulta anónima aunque Gateway esté en demo', async () => {
        vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'false');
        await request(gateway)
          .get(`${commercial}?skus=${sku}&canal=MARKETPLACE`)
          .expect(401);
      });

      it('Gateway conserva VALIDACION y 503 en el GET comercial', async () => {
        const invalid = await request(gateway)
          .get(`${commercial}?skus=${sku}&canal=VENTAS`)
          .expect(400);
        expect(invalid.body.code).toBe('VALIDACION');
        vi.spyOn(db, 'query').mockRejectedValueOnce(
          Object.assign(new Error('DB caída'), { code: 'ECONNREFUSED' }),
        );
        const unavailable = await request(gateway)
          .get(`${commercial}?skus=${sku}&canal=MARKETPLACE`)
          .expect(503);
        expect(unavailable.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      });

      it.each([
        {
          body: input('MARKETPLACE', 0),
          status: 400,
          code: 'VALIDACION',
          failure: 'validation',
        },
        {
          body: { ...input(), fulfillment: { mode: 'INVALIDO' } },
          status: 422,
          code: 'CONTEXTO_ABASTECIMIENTO_INVALIDO',
          failure: 'context',
        },
        { body: input(), status: 401, code: 'TOKEN_INVALIDO', failure: 'auth' },
        {
          body: input(),
          status: 503,
          code: 'SERVICIO_NO_DISPONIBLE',
          failure: 'db',
        },
      ])(
        'caracteriza brecha externa: Gateway convierte $code/$status del verificador en ERROR_INTERNO',
        async ({ body, status, code, failure }) => {
          if (failure === 'auth')
            vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'false');
          if (failure === 'db')
            vi.spyOn(db, 'query').mockRejectedValue(
              Object.assign(new Error('DB caída'), { code: 'ECONNREFUSED' }),
            );
          const provider = await request(origin)
            .post(verify)
            .send(body)
            .expect(status);
          expect(provider.body.code).toBe(code);
          const proxied = await request(gateway)
            .post(verify)
            .send(body)
            .expect(500);
          expect(proxied.body.code).toBe('ERROR_INTERNO'); // #107: responses.400.codes vacío en CONTRACT_ROUTES.
        },
      );
    },
  );
});
