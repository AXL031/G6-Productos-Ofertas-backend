import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReservationsService } from './reservations.service.js';
import { ReservationExpirationService } from './reservation-expiration.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

import { DrizzleReservationsRepository } from '../repositories/drizzle/drizzle-reservations.repository.js';
import { DrizzleStockBalanceRepository } from '../repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleOperationsRepository } from '../repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleLocationsRepository } from '../repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleCommercialRoutesRepository } from '../repositories/drizzle/drizzle-commercial-routes.repository.js';
import { DrizzleKardexRepository } from '../repositories/drizzle/drizzle-kardex.repository.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';

describe('ReservationExpirationService & Expiración Transaccional — Casos Obligatorios', () => {
  let reservationsService: ReservationsService;
  let expirationService: ReservationExpirationService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';
  const sku = 'NIK-REV7-NEG-41';

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);

    const idempotencyService = new IdempotencyService();
    const kardexRepo = new DrizzleKardexRepository(dbService);
    const kardexService = new KardexService(kardexRepo);
    const outboxRepo = new DrizzleOutboxRepository(dbService);
    const outboxService = new OutboxService(outboxRepo);

    const reservationsRepo = new DrizzleReservationsRepository(dbService);
    const stockBalanceRepo = new DrizzleStockBalanceRepository(dbService);
    const operationsRepo = new DrizzleOperationsRepository(dbService);
    const locationsRepo = new DrizzleLocationsRepository(dbService);
    const commercialRoutesRepo = new DrizzleCommercialRoutesRepository(
      dbService,
    );

    reservationsService = new ReservationsService(
      dbService,
      idempotencyService,
      kardexService,
      outboxService,
      reservationsRepo,
      stockBalanceRepo,
      operationsRepo,
      locationsRepo,
      commercialRoutesRepo,
    );

    expirationService = new ReservationExpirationService(
      dbService,
      reservationsService,
      reservationsRepo,
    );
  });

  it('una consulta fallida no informa falsamente que no hay reservas vencidas', async () => {
    vi.spyOn(dbService, 'query').mockRejectedValueOnce(
      new Error('DB no disponible'),
    );
    await expect(expirationService.expirarReservasVencidas()).rejects.toThrow(
      'DB no disponible',
    );
    expect(await expirationService.expirarReservasVencidas()).toEqual({
      procesadas: 0,
      expiradas: 0,
      fallidas: 0,
    });
  });

  it('1. Caso obligatorio: expiración automática debe procesar reservas vencidas sin duplicar eventos', async () => {
    const resId = randomUUID();
    const orderId = 'ORD-EXP-AUTO-01';

    // Configurar saldo con stock reservado
    const bal = mockDb.stockBalance.find(
      (b) => b.sku_id === sku && b.location_id === locLurin,
    )!;
    bal.reserved = 5;

    // Crear reserva vencida en el pasado
    const pastDate = new Date(Date.now() - 60000).toISOString();
    mockDb.reservations.push({
      id: 'res-pk-exp-1',
      reservation_id: resId,
      status: 'ACTIVA',
      expires_at: pastDate,
      idempotency_key: 'idemp-exp-1234',
      intention: 'reservar',
      order_id: orderId,
      correlation_id: 'corr-exp-1',
    });

    mockDb.reservationLines.push({
      id: 'line-exp-1',
      reservation_id: 'res-pk-exp-1',
      sku_id: sku,
      location_id: locLurin,
      quantity: 5,
    });

    const result = await expirationService.expirarReservasVencidas();

    expect(result.procesadas).toBe(1);
    expect(result.expiradas).toBe(1);
    expect(result.fallidas).toBe(0);

    // Estado de reserva actualizado
    const updatedRes = mockDb.reservations.find(
      (r) => r.reservation_id === resId,
    )!;
    expect(updatedRes.status).toBe('EXPIRADA');

    // Saldo reservado liberado
    expect(bal.reserved).toBe(0);

    // Evento outbox generado
    const expiredEvent = mockDb.outbox.find(
      (o) => o.event_type === 'inventory.reservation.expired',
    );
    expect(expiredEvent).toBeDefined();

    // Segunda ejecución idempotente no debe duplicar expiraciones
    const secondRun = await expirationService.expirarReservasVencidas();
    expect(secondRun.expiradas).toBe(0);
  });

  it('2. Caso obligatorio: carrera expiración/confirmación debe rechazar confirmación tras adquirir bloqueo si ya venció', async () => {
    const resId = randomUUID();
    const orderId = 'ORD-RACE-01';
    const opId = randomUUID();

    // Reserva con expires_at en el pasado pero aún ACTIVA en BD
    const pastDate = new Date(Date.now() - 5000).toISOString();
    mockDb.reservations.push({
      id: 'res-pk-race',
      reservation_id: resId,
      status: 'ACTIVA',
      expires_at: pastDate,
      idempotency_key: 'idemp-race-123',
      intention: 'reservar',
      order_id: orderId,
      correlation_id: 'corr-race-1',
    });

    const bal = mockDb.stockBalance.find(
      (b) => b.sku_id === sku && b.location_id === locLurin,
    )!;
    bal.reserved = 2;

    mockDb.reservationLines.push({
      id: 'line-race-1',
      reservation_id: 'res-pk-race',
      sku_id: sku,
      location_id: locLurin,
      quantity: 2,
    });

    // Intentar confirmar reserva vencida
    await expect(
      reservationsService.confirmarReserva(
        resId,
        {
          order_id: orderId,
          operation_id: opId,
        },
        'corr-race-1',
        'idemp-confirm-race-1234',
        'modulo-ventas',
      ),
    ).rejects.toThrow(ProblemDetailsException);

    try {
      await reservationsService.confirmarReserva(
        resId,
        {
          order_id: orderId,
          operation_id: opId,
        },
        'corr-race-1',
        'idemp-confirm-race-1234',
        'modulo-ventas',
      );
    } catch (err: any) {
      expect(err.problem.status).toBe(409);
      expect(err.problem.code).toBe('RESERVA_EXPIRADA');
    }
  });

  it('3. Caso obligatorio: saldo faltante en base física debe hacer rollback completo sin mutar la reserva', async () => {
    const resId = randomUUID();
    const orderId = 'ORD-MISSING-BAL';
    const pastDate = new Date(Date.now() - 60000).toISOString();

    mockDb.reservations.push({
      id: 'res-pk-missing-bal',
      reservation_id: resId,
      status: 'ACTIVA',
      expires_at: pastDate,
      idempotency_key: 'idemp-missing-bal-123',
      intention: 'reservar',
      order_id: orderId,
    });

    // Línea apuntando a SKU que NO existe en stock_balance
    mockDb.reservationLines.push({
      id: 'line-missing-1',
      reservation_id: 'res-pk-missing-bal',
      sku_id: 'SKU-INEXISTENTE',
      location_id: locLurin,
      quantity: 3,
    });

    // Debe fallar y hacer rollback completo
    await expect(
      reservationsService.expirarReservaDurable(resId, orderId),
    ).rejects.toThrow(/Inconsistencia.*saldo/i);

    // La reserva debe permanecer ACTIVA debido al rollback transaccional
    const resRow = mockDb.reservations.find((r) => r.reservation_id === resId)!;
    expect(resRow.status).toBe('ACTIVA');

    // No debe generarse evento outbox
    const outboxEvent = mockDb.outbox.find(
      (o) => o.event_type === 'inventory.reservation.expired',
    );
    expect(outboxEvent).toBeUndefined();
  });

  it('4. Caso obligatorio: reserved insuficiente debe hacer rollback y NO forzar reserved=0', async () => {
    const resId = randomUUID();
    const orderId = 'ORD-INSUFFICIENT-RES';
    const pastDate = new Date(Date.now() - 60000).toISOString();

    const bal = mockDb.stockBalance.find(
      (b) => b.sku_id === sku && b.location_id === locLurin,
    )!;
    // Stock reservado en BD es 2, pero la reserva pide liberar 5 (inconsistencia grave)
    bal.reserved = 2;

    mockDb.reservations.push({
      id: 'res-pk-insuf-res',
      reservation_id: resId,
      status: 'ACTIVA',
      expires_at: pastDate,
      idempotency_key: 'idemp-insuf-res-123',
      intention: 'reservar',
      order_id: orderId,
    });

    mockDb.reservationLines.push({
      id: 'line-insuf-1',
      reservation_id: 'res-pk-insuf-res',
      sku_id: sku,
      location_id: locLurin,
      quantity: 5,
    });

    // Debe fallar con error de inconsistencia y hacer rollback completo
    await expect(
      reservationsService.expirarReservaDurable(resId, orderId),
    ).rejects.toThrow(/Inconsistencia.*stock reservado/i);

    // Verificar que NO se forzó reserved=0 y la transacción se revirtió
    expect(bal.reserved).toBe(2);

    // La reserva debe permanecer ACTIVA
    const resRow = mockDb.reservations.find((r) => r.reservation_id === resId)!;
    expect(resRow.status).toBe('ACTIVA');
  });
});
