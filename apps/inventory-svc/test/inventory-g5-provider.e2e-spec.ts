import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import { OutboxService } from '../src/outbox/outbox.service.js';
import type { ReintegroInventarioRequest } from '../src/types/inventory.dto.js';
import { InMemoryDatabaseMock } from './in-memory-database.mock.js';
import {
  createCryptographicJwt,
  TEST_ISSUER,
  TEST_PUBLIC_KEY,
} from './crypto-test-token.helper.js';

const root = '/api/v1/inventario';
const sku = 'NIK-REV7-NEG-41';
const location = '9129b578-631e-1735-8427-b683fb524380';
const otherLocation = 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485';
const allScopes =
  'inventario:reservar inventario:consumir inventario:liberar inventario:operaciones:leer inventario:disponibilidad:leer inventario:reintegrar';

// Provider HTTP con JWT sintético firmado y DB en memoria: no representa un E2E bilateral G5/G7.
describe('Inventory provider para G5 M1/M2 (#30/#31)', () => {
  let app: INestApplication;
  let origin: string;
  let db: InMemoryDatabaseMock;
  let outbox: OutboxService;
  const tokens: Record<string, string> = {};
  const state = () =>
    structuredClone({
      stock: db.stockBalance,
      reservations: db.reservations,
      operations: db.operations,
      kardex: db.kardex,
      outbox: db.outbox,
    });
  const balance = () =>
    db.stockBalance.find(
      (row) => row.sku_id === sku && row.location_id === location,
    )!;
  const reserve = (quantity = 2) => ({
    operation_id: randomUUID(),
    order_id: 'PED-G5/2026-42',
    channel_id: 'MARKETPLACE',
    lines: [{ sku, quantity, location_id: location }],
  });
  const refund = (
    overrides: Partial<ReintegroInventarioRequest> = {},
  ): ReintegroInventarioRequest => ({
    operation_id: randomUUID(),
    order_id: 'PED-G5/2026-42',
    source_ref: 'DEV-G5/42',
    reason: 'DEVOLUCION_ACEPTADA',
    lines: [{ sku, quantity: 2, location_id: location }],
    ...overrides,
  });
  const post = <T extends { operation_id: string }>(
    path: string,
    dto: T,
    client = 'modulo-ventas',
    correlation = randomUUID(),
    key = dto.operation_id,
  ) =>
    request(origin)
      .post(`${root}${path}`)
      .auth(tokens[client], { type: 'bearer' })
      .set('Idempotency-Key', key)
      .set('X-Correlation-ID', correlation)
      .send(dto);
  const operation = (id: string) =>
    request(origin)
      .get(`${root}/operaciones/${id}`)
      .auth(tokens['modulo-ventas'], { type: 'bearer' });
  async function activeReservation() {
    const dto = reserve();
    await post('/reservas', dto).expect(202);
    return { dto, id: db.reservations[0].reservation_id };
  }
  beforeAll(async () => {
    vi.stubEnv('RABBITMQ_URL', undefined);
    vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'false');
    vi.stubEnv('G7_JWT_ISSUER', TEST_ISSUER);
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
    for (const clientId of [
      'modulo-ventas',
      'modulo-postventa',
      'modulo-retail',
      'modulo-marketplace',
    ]) {
      tokens[clientId] = createCryptographicJwt({ clientId, scope: allScopes });
    }
    db = new InMemoryDatabaseMock();
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    })
      .overrideProvider(InventoryWorkersService)
      .useValue({})
      .compile();
    module.get(DatabaseService).setCustomService(db);
    outbox = module.get(OutboxService);
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    db.seedDefaults();
    vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'false');
  });
  afterAll(async () => {
    await app?.close();
    InventoryAuthGuard.setTrustedPublicKey(null);
    vi.unstubAllEnvs();
  });

  it('M1 reserva, consulta el resultado durable y confirma una sola vez tras perder la respuesta', async () => {
    const dto = reserve(3);
    const correlation = randomUUID();
    const accepted = await post(
      '/reservas',
      dto,
      'modulo-ventas',
      correlation,
    ).expect(202);
    expect(accepted.body).toEqual({
      operation_id: dto.operation_id,
      order_id: dto.order_id,
      operation_type: 'RESERVAR',
      status: 'ACCEPTED',
      correlation_id: correlation,
    });
    const durable = await operation(dto.operation_id).expect(200);
    expect(durable.body).toMatchObject({
      operation_id: dto.operation_id,
      order_id: dto.order_id,
      operation_type: 'RESERVAR',
      status: 'COMPLETED',
      reservation_id: db.reservations[0].reservation_id,
    });
    expect(Number.isFinite(Date.parse(durable.body.expires_at))).toBe(true);
    expect(balance()).toMatchObject({
      on_hand: 18,
      reserved: 3,
      available: 15,
    });
    expect(
      db.outbox.find(
        (row) => row.event_type === 'inventory.reservation.created',
      )?.payload,
    ).toMatchObject({
      operation_id: dto.operation_id,
      correlation_id: correlation,
      data: {
        order_id: dto.order_id,
        reservation_id: durable.body.reservation_id,
      },
    });
    const confirm = { order_id: dto.order_id, operation_id: randomUUID() };
    const confirmCorrelation = randomUUID();
    const first = await post(
      `/reservas/${durable.body.reservation_id}/confirmar`,
      confirm,
      'modulo-ventas',
      confirmCorrelation,
    ).expect(202);
    expect(first.body.status).toBe('ACCEPTED');
    expect(
      (await operation(confirm.operation_id).expect(200)).body,
    ).toMatchObject({
      status: 'COMPLETED',
      operation_type: 'CONFIRMAR_CONSUMO',
    });
    expect(balance()).toMatchObject({
      on_hand: 15,
      reserved: 0,
      available: 15,
    });
    const before = state();
    expect((await post('/reservas', dto).expect(202)).body).toEqual(
      accepted.body,
    );
    expect(
      (
        await post(
          `/reservas/${durable.body.reservation_id}/confirmar`,
          confirm,
        ).expect(202)
      ).body,
    ).toEqual(first.body);
    expect(state()).toEqual(before);
    expect(
      db.outbox.find(
        (row) => row.event_type === 'inventory.consumption.completed',
      )?.payload,
    ).toMatchObject({
      operation_id: confirm.operation_id,
      correlation_id: confirmCorrelation,
      data: { order_id: dto.order_id },
    });
  });

  it('un 202 con stock insuficiente se consulta como REJECTED y no crea una reserva', async () => {
    const dto = reserve(19);
    const initial = structuredClone(db.stockBalance);
    const accepted = await post('/reservas', dto).expect(202);
    expect(accepted.body.status).toBe('ACCEPTED');
    expect((await operation(dto.operation_id).expect(200)).body).toMatchObject({
      status: 'REJECTED',
      result_code: 'STOCK_INSUFICIENTE',
      reservation_id: null,
    });
    expect(db.reservations).toHaveLength(0);
    expect(db.stockBalance).toEqual(initial);
    expect(db.kardex).toHaveLength(0);
    expect(db.outbox.map((row) => row.event_type)).toEqual([
      'inventory.reservation.rejected',
    ]);
    const before = state();
    expect((await post('/reservas', dto).expect(202)).body).toEqual(
      accepted.body,
    );
    expect(state()).toEqual(before);
  });

  it('liberar por pago no completado restaura reserved y bloquea un consumo posterior', async () => {
    const { dto, id } = await activeReservation();
    const release = {
      operation_id: randomUUID(),
      order_id: dto.order_id,
      reason: 'PAGO_NO_COMPLETADO',
    };
    const first = await post(`/reservas/${id}/liberar`, release).expect(202);
    expect(
      (await operation(release.operation_id).expect(200)).body,
    ).toMatchObject({ status: 'COMPLETED', operation_type: 'LIBERAR' });
    expect(balance()).toMatchObject({
      on_hand: 18,
      reserved: 0,
      available: 18,
    });
    const before = state();
    expect(
      (await post(`/reservas/${id}/liberar`, release).expect(202)).body,
    ).toEqual(first.body);
    const confirm = { operation_id: randomUUID(), order_id: dto.order_id };
    expect(
      (await post(`/reservas/${id}/confirmar`, confirm).expect(409)).body.code,
    ).toBe('RESERVA_NO_ACTIVA');
    expect(state()).toEqual(before);
  });

  it('la confirmación vencida persiste expiración y libera stock aunque responda 409', async () => {
    const { dto, id } = await activeReservation();
    db.reservations[0].expires_at = new Date(Date.now() - 60_000).toISOString();
    const confirm = { operation_id: randomUUID(), order_id: dto.order_id };
    expect(
      (await post(`/reservas/${id}/confirmar`, confirm).expect(409)).body.code,
    ).toBe('RESERVA_EXPIRADA');
    expect(db.reservations[0].status).toBe('EXPIRADA');
    expect(balance()).toMatchObject({
      on_hand: 18,
      reserved: 0,
      available: 18,
    });
    const before = state();
    expect(
      (await post(`/reservas/${id}/confirmar`, confirm).expect(409)).body.code,
    ).toBe('RESERVA_EXPIRADA');
    expect(state()).toEqual(before);
    expect((await operation(confirm.operation_id).expect(404)).body.code).toBe(
      'OPERACION_INVENTARIO_NO_ENCONTRADA',
    );
  });

  it('M2 consulta disponibilidad informativa sin reservar ni modificar saldos', async () => {
    const before = state();
    const result = await request(origin)
      .get(`${root}/disponibilidad`)
      .query({ skus: sku, location_id: location })
      .auth(tokens['modulo-postventa'], { type: 'bearer' })
      .expect(200);
    expect(result.body.items).toEqual([
      expect.objectContaining({
        sku,
        location_id: location,
        on_hand: 18,
        available: 18,
      }),
    ]);
    expect(state()).toEqual(before);
    await request(origin)
      .get(`${root}/disponibilidad/comercial`)
      .query({ skus: sku, canal: 'MARKETPLACE' })
      .auth(tokens['modulo-postventa'], { type: 'bearer' })
      .expect(403);
    expect(state()).toEqual(before);
  });

  it('M2 no puede reservar, confirmar, liberar ni consultar operaciones aunque presente scopes M1', async () => {
    const { dto, id } = await activeReservation();
    const before = state();
    await post('/reservas', reserve(), 'modulo-postventa').expect(403);
    await post(
      `/reservas/${id}/confirmar`,
      { operation_id: randomUUID(), order_id: dto.order_id },
      'modulo-postventa',
    ).expect(403);
    await post(
      `/reservas/${id}/liberar`,
      {
        operation_id: randomUUID(),
        order_id: dto.order_id,
        reason: 'ANULACION',
      },
      'modulo-postventa',
    ).expect(403);
    await request(origin)
      .get(`${root}/operaciones/${dto.operation_id}`)
      .auth(tokens['modulo-postventa'], { type: 'bearer' })
      .expect(403);
    expect(state()).toEqual(before);
  });

  it('F3 conserva reserved/blocked, registra evidencia atómica y reproduce el snapshot original', async () => {
    const row = balance();
    row.reserved = 3;
    row.blocked = 2;
    row.available = 13;
    const dto = refund();
    const correlation = randomUUID();
    const first = await post(
      '/reintegros',
      dto,
      'modulo-postventa',
      correlation,
    ).expect(200);
    expect(first.body).toMatchObject({
      status: 'COMPLETED',
      operation_id: dto.operation_id,
      order_id: dto.order_id,
      source_ref: dto.source_ref,
      lines: [
        {
          sku,
          location_id: location,
          quantity: 2,
          on_hand: 20,
          reserved: 3,
          blocked: 2,
          available: 15,
          stock_version: 2,
        },
      ],
    });
    expect(Number.isFinite(Date.parse(first.body.completed_at))).toBe(true);
    expect(db.kardex).toEqual([
      expect.objectContaining({
        operation_type: 'REINTEGRO',
        operation_id: dto.operation_id,
        quantity: 2,
        on_hand_before: 18,
        on_hand_after: 20,
        reserved_before: 3,
        reserved_after: 3,
        blocked_before: 2,
        blocked_after: 2,
      }),
    ]);
    expect(db.outbox[0].payload).toMatchObject({
      operation_id: dto.operation_id,
      correlation_id: correlation,
      data: {
        sku,
        location_id: location,
        on_hand: 20,
        reserved: 3,
        blocked: 2,
        available: 15,
        stock_version: 2,
      },
    });
    const secondReceipt = refund({
      lines: [{ sku, quantity: 1, location_id: location }],
    });
    await post('/reintegros', secondReceipt, 'modulo-postventa').expect(200);
    expect(balance().on_hand).toBe(21);
    const before = state();
    expect(
      (await post('/reintegros', dto, 'modulo-postventa').expect(200)).body,
    ).toEqual(first.body);
    expect(
      (
        await post(
          '/reintegros',
          { ...dto, lines: [{ sku, quantity: 3, location_id: location }] },
          'modulo-postventa',
        ).expect(409)
      ).body.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(state()).toEqual(before);
    expect(db.kardex).toHaveLength(2);
    expect(db.operations).toHaveLength(2);
    expect(db.outbox).toHaveLength(2);
  });

  it.each(['modulo-retail', 'modulo-marketplace'])(
    '%s no ejecuta F3 aunque presente scope de reintegro',
    async (client) => {
      const before = state();
      await post('/reintegros', refund(), client).expect(403);
      expect(state()).toEqual(before);
    },
  );

  it('M1 solo reintegra motivos distintos de DEVOLUCION_ACEPTADA', async () => {
    expect((await post('/reintegros', refund()).expect(422)).body.code).toBe(
      'REINTEGRO_NO_APLICABLE',
    );
    expect(db.operations).toHaveLength(0);
    await post('/reintegros', refund({ reason: 'RETORNO_LOGISTICO' })).expect(
      200,
    );
    expect(balance().on_hand).toBe(20);
  });

  it.each(['ausente', 'inactiva', 'sin saldo'])(
    'F3 rechaza ubicación %s sin asumir una receptora',
    async (scenario) => {
      const locationId = scenario === 'ausente' ? randomUUID() : location;
      if (scenario === 'inactiva')
        db.locations.find((row) => row.id === location)!.active = false;
      if (scenario === 'sin saldo')
        db.stockBalance = db.stockBalance.filter(
          (row) => row.sku_id !== sku || row.location_id !== location,
        );
      const before = state();
      const dto = refund({
        lines: [{ sku, quantity: 2, location_id: locationId }],
      });
      expect(
        (await post('/reintegros', dto, 'modulo-postventa').expect(422)).body
          .code,
      ).toBe(
        scenario === 'sin saldo'
          ? 'SKU_NO_ENCONTRADO'
          : 'UBICACION_NO_ENCONTRADA',
      );
      expect(state()).toEqual(before);
    },
  );

  it('product_id no sustituye al SKU de la línea original', async () => {
    const dto = {
      ...refund(),
      lines: [{ product_id: randomUUID(), quantity: 2, location_id: location }],
    };
    const before = state();
    expect(
      (await post('/reintegros', dto, 'modulo-postventa').expect(400)).body
        .code,
    ).toBe('VALIDACION');
    expect(state()).toEqual(before);
  });

  it('un fallo al guardar Outbox revierte stock, operación y Kardex; permite reintentar', async () => {
    const dto = refund();
    const correlation = randomUUID();
    const before = state();
    vi.spyOn(outbox, 'stockChanged').mockRejectedValueOnce(
      Object.assign(new Error('postgres://secreto-sintetico'), {
        code: '08006',
      }),
    );
    const failure = await post(
      '/reintegros',
      dto,
      'modulo-postventa',
      correlation,
    ).expect(503);
    expect(failure.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(failure.body).toMatchObject({
      code: 'SERVICIO_NO_DISPONIBLE',
      correlationId: correlation,
    });
    expect(JSON.stringify(failure.body)).not.toContain('secreto-sintetico');
    expect(state()).toEqual(before);
    await post('/reintegros', dto, 'modulo-postventa').expect(200);
    expect(db.kardex).toHaveLength(1);
    expect(db.operations).toHaveLength(1);
    expect(db.outbox).toHaveLength(1);
  });

  it('un desbordamiento en la segunda ubicación revierte todo el reintegro HTTP', async () => {
    const locations = [location, otherLocation].sort((a, b) =>
      a.localeCompare(b),
    );
    const last = db.stockBalance.find(
      (row) => row.sku_id === sku && row.location_id === locations[1],
    )!;
    last.on_hand = 2_147_483_647;
    last.available = last.on_hand;
    const before = state();
    const dto = refund({
      lines: locations.map((location_id) => ({
        sku,
        quantity: 1,
        location_id,
      })),
    });
    expect(
      (await post('/reintegros', dto, 'modulo-postventa').expect(422)).body
        .code,
    ).toBe('CANTIDAD_INVALIDA');
    expect(state()).toEqual(before);
  });

  it('la demo comercial activa mantiene JWT obligatorio en las operaciones G5', async () => {
    vi.stubEnv('INVENTORY_DEMO_NO_AUTH_ENABLED', 'true');
    vi.stubEnv('INVENTORY_DEMO_GATEWAY_IPS', '127.0.0.1');
    const before = state();
    for (const [path, dto] of [
      ['/reservas', reserve()],
      [`/reservas/${randomUUID()}/confirmar`, reserve()],
      [`/reservas/${randomUUID()}/liberar`, reserve()],
      ['/reintegros', refund()],
    ] as const) {
      await request(origin)
        .post(`${root}${path}`)
        .set('Idempotency-Key', dto.operation_id)
        .send(dto)
        .expect(401);
    }
    await request(origin)
      .get(`${root}/disponibilidad`)
      .query({ skus: sku, location_id: location })
      .expect(401);
    await request(origin)
      .get(`${root}/operaciones/${randomUUID()}`)
      .expect(401);
    expect(state()).toEqual(before);
  });
});
