import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { InventorySvcModule } from '../src/inventory-svc.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { ProblemDetailsFilter } from '../src/errors/problem-details.filter.js';
import { InventoryAuthGuard } from '../src/auth/inventory-auth.guard.js';
import { InMemoryDatabaseMock } from './in-memory-database.mock.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from './crypto-test-token.helper.js';

describe('Inventory — contrato HTTP de consultas y escrituras (#99/#100/#101)', () => {
  let app: INestApplication;
  let db: InMemoryDatabaseMock;
  const sku = 'NIK-REV7-NEG-41';
  const locationId = '9129b578-631e-1735-8427-b683fb524380';
  const detailPath = `/api/v1/inventario/disponibilidad?skus=${sku}&location_id=${locationId}`;
  const service = () => createCryptographicJwt({ clientId: 'modulo-ventas' });
  const human = (options: Parameters<typeof createCryptographicJwt>[0] = {}) =>
    createCryptographicJwt({
      tipo: 'acceso',
      sub: '00000000-0000-4000-8000-000000000001',
      roles: ['GESTOR_COMERCIAL'],
      scope: '',
      includeAudience: false,
      ...options,
    });
  const state = () =>
    structuredClone({
      stock: db.stockBalance,
      reservations: db.reservations,
      operations: db.operations,
      kardex: db.kardex,
      outbox: db.outbox,
    });

  beforeAll(() => {
    vi.stubEnv('G7_JWT_ISSUER', TEST_ISSUER);
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
  });
  afterAll(() => {
    InventoryAuthGuard.setTrustedPublicKey(null);
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    db = new InMemoryDatabaseMock();
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();
    module.get(DatabaseService).setCustomService(db);
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('lista saldos físicos y ubicaciones reales para el gestor, con 503 ante fallo de persistencia', async () => {
    const path = '/api/v1/inventario/administracion/saldos';
    const http = request(app.getHttpServer());
    const manager = 'Bearer ' + human();
    const transaction = vi.spyOn(db, 'transaction');
    await http.get(path).expect(401);
    await http
      .get(path)
      .set('Authorization', 'Bearer ' + human({ roles: [] }))
      .expect(403);
    await http
      .get(path)
      .set('Authorization', 'Bearer ' + service())
      .expect(401);
    await http
      .get(path + '?locationId=incorrecta')
      .set('Authorization', manager)
      .expect(400);
    await http
      .get(path + '?tamanio=101')
      .set('Authorization', manager)
      .expect(400);
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockResolvedValueOnce({
      total: 1,
      rows: [
        {
          sku,
          locationId,
          locationCode: 'ALM-01',
          locationName: 'Almacén central',
          locationType: 'ALMACEN',
          locationActive: false,
          skuActivo: null,
          onHand: 9,
          reserved: 2,
          blocked: 3,
          available: 4,
          stockVersion: '6',
          updatedAt: new Date('2026-11-07T00:00:00Z'),
          umbralEfectivo: 4,
          estado: 'STOCK_BAJO',
        },
      ],
    });
    const found = await http
      .get(path + '?tamanio=1&estado=STOCK_BAJO')
      .set('Authorization', manager)
      .expect(200);
    expect(found.body).toMatchObject({
      items: [
        {
          sku,
          ubicacion: { locationId, nombre: 'Almacén central', activa: false },
          skuActivo: null,
          onHand: 9,
          reserved: 2,
          blocked: 3,
          available: 4,
          stockVersion: 6,
          estado: 'STOCK_BAJO',
        },
      ],
      meta: { pagina: 1, tamanio: 1, total: 1, totalPaginas: 1 },
    });
    transaction.mockRejectedValueOnce(new Error('postgres unavailable'));
    const outage = await http
      .get(path)
      .set('Authorization', manager)
      .expect(503);
    expect(outage.body.code).toBe('SERVICIO_NO_DISPONIBLE');
  });

  it.each([
    detailPath,
    '/api/v1/inventario/umbrales',
    '/api/v1/inventario/dashboard',
  ])(
    'permite la consulta humana autorizada sin convertirla en cliente de servicio: %s',
    async (path) => {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${human()}`)
        .expect(200);
    },
  );

  it.each([
    {
      name: 'issuer incorrecto',
      options: { iss: 'https://emisor-no-confiable.test' },
      status: 401,
    },
    { name: 'sin rol', options: { roles: [] }, status: 403 },
    {
      name: 'capacidad sin rol global',
      options: { roles: [], capabilities: ['INVENTARIO_TRASLADOS_LEER'] },
      status: 403,
    },
    { name: 'firma alterada', options: { tamperSignature: true }, status: 401 },
    {
      name: 'vencimiento alcanzado',
      options: { exp: Math.floor(Date.now() / 1000) },
      status: 401,
    },
    { name: 'sub vacío', options: { sub: '' }, status: 401 },
  ])('rechaza token humano con $name', async ({ options, status }) => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/inventario/umbrales')
      .set('Authorization', `Bearer ${human(options)}`)
      .expect(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('el issuer ausente en configuración cierra la autorización humana', async () => {
    const previousIssuer = process.env.G7_JWT_ISSUER;
    delete process.env.G7_JWT_ISSUER;
    try {
      await request(app.getHttpServer())
        .get('/api/v1/inventario/umbrales')
        .set('Authorization', `Bearer ${human()}`)
        .expect(401);
    } finally {
      process.env.G7_JWT_ISSUER = previousIssuer;
    }
  });

  it('un servicio no accede al área humana aunque incluya el rol en sus claims', async () => {
    const token = createCryptographicJwt({ roles: ['GESTOR_COMERCIAL'] });
    await request(app.getHttpServer())
      .get('/api/v1/inventario/umbrales')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('un servicio comercial no usa la vía humana para saltarse la allowlist detallada', async () => {
    const token = createCryptographicJwt({
      clientId: 'modulo-marketplace',
      roles: ['GESTOR_COMERCIAL'],
    });
    await request(app.getHttpServer())
      .get(detailPath)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('un humano no consulta operaciones técnicas ni crea reservas', async () => {
    const before = state();
    await request(app.getHttpServer())
      .get(`/api/v1/inventario/operaciones/${randomUUID()}`)
      .set('Authorization', `Bearer ${human()}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .set('Authorization', `Bearer ${human()}`)
      .send({})
      .expect(401);
    expect(state()).toEqual(before);
  });

  it('mantiene traslados cerrados en G7 hasta definir los grants locales, incluso con un claim adicional', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/inventario/traslados')
      .set('Authorization', `Bearer ${human()}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/inventario/traslados')
      .set(
        'Authorization',
        `Bearer ${human({ capabilities: ['INVENTARIO_TRASLADOS_LEER'] })}`,
      )
      .expect(403);
  });

  it('exige ubicación explícita si los saldos corresponden a ubicaciones diferentes', async () => {
    const before = state();
    const res = await request(app.getHttpServer())
      .get(`/api/v1/inventario/disponibilidad?skus=${sku}`)
      .set('Authorization', `Bearer ${service()}`)
      .expect(400);
    expect(res.body.code).toBe('VALIDACION');
    expect(state()).toEqual(before);
  });

  it('admite omitir ubicación cuando el saldo tiene una sola ubicación inequívoca', async () => {
    db.stockBalance = db.stockBalance.filter(
      (row) => row.location_id === locationId,
    );
    await request(app.getHttpServer())
      .get(`/api/v1/inventario/disponibilidad?skus=${sku}`)
      .set('Authorization', `Bearer ${service()}`)
      .expect(200);
  });

  it.each([
    '/api/v1/inventario/dashboard?locationId=no-uuid',
    '/api/v1/inventario/traslados?target_location_id=no-uuid',
  ])(
    'rechaza filtros de ubicación inválidos antes de consultar PostgreSQL: %s',
    async (path) => {
      const query = vi.spyOn(db, 'query');
      const res = await request(app.getHttpServer())
        .get(path)
        .set(
          'Authorization',
          `Bearer ${human({ capabilities: ['INVENTARIO_TRASLADOS_LEER'] })}`,
        )
        .expect(path.includes('/traslados') ? 403 : 400);
      expect(res.body.code).toBe(
        path.includes('/traslados') ? 'SCOPE_INSUFICIENTE' : 'VALIDACION',
      );
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('no filtra detalles internos al convertir errores técnicos a Problem Details', async () => {
    vi.spyOn(db, 'query').mockRejectedValueOnce(
      new Error('password=secreto-de-prueba /ruta-interna'),
    );
    const res = await request(app.getHttpServer())
      .get(detailPath)
      .set('Authorization', `Bearer ${service()}`)
      .expect(500);
    expect(res.body.code).toBe('ERROR_INTERNO');
    expect(JSON.stringify(res.body)).not.toMatch(
      /secreto-de-prueba|ruta-interna/,
    );
  });

  it('devuelve 503 sin detalles cuando PostgreSQL no es alcanzable', async () => {
    vi.spyOn(db, 'query').mockRejectedValueOnce(
      Object.assign(new Error('servidor-privado'), { code: 'ECONNREFUSED' }),
    );
    const res = await request(app.getHttpServer())
      .get(detailPath)
      .set('Authorization', `Bearer ${service()}`)
      .expect(503);
    expect(res.body.code).toBe('SERVICIO_NO_DISPONIBLE');
    expect(JSON.stringify(res.body)).not.toContain('servidor-privado');
  });

  it.each([null, [], { quantity: 2 }])(
    'reserva con línea malformada responde 400 sin efectos: %j',
    async (line) => {
      const before = state();
      const res = await request(app.getHttpServer())
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${service()}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          order_id: 'PED-VALIDACION',
          operation_id: randomUUID(),
          channel_id: 'MARKETPLACE',
          lines: [line],
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDACION');
      expect(state()).toEqual(before);
    },
  );

  it('reintegro con línea nula responde 400 sin efectos', async () => {
    const before = state();
    await request(app.getHttpServer())
      .post('/api/v1/inventario/reintegros')
      .set(
        'Authorization',
        `Bearer ${createCryptographicJwt({ clientId: 'modulo-postventa', scope: 'inventario:reintegrar' })}`,
      )
      .set('Idempotency-Key', randomUUID())
      .send({
        operation_id: randomUUID(),
        order_id: 'PED-VALIDACION',
        source_ref: 'DEV-VALIDACION',
        reason: 'DEVOLUCION_ACEPTADA',
        lines: [null],
      })
      .expect(400);
    expect(state()).toEqual(before);
  });

  it.each([
    {
      label: 'UUID como array',
      override: { operation_id: [randomUUID()] },
      status: 400,
    },
    {
      label: 'cantidad fuera del entero seguro',
      override: {
        lines: [
          {
            sku,
            location_id: locationId,
            quantity: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      },
      status: 422,
    },
  ])(
    'rechaza $label antes de persistir una reserva',
    async ({ override, status }) => {
      const before = state();
      await request(app.getHttpServer())
        .post('/api/v1/inventario/reservas')
        .set('Authorization', `Bearer ${service()}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          order_id: 'PED-INVALIDO',
          operation_id: randomUUID(),
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 1, location_id: locationId }],
          ...override,
        })
        .expect(status);
      expect(state()).toEqual(before);
    },
  );
});
