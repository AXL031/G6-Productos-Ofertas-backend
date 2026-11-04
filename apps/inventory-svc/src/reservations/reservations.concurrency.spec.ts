import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReservationsService } from './reservations.service.js';
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

describe('ReservationsService — Concurrencia, Idempotencia y Saldos', () => {
  let reservationsService: ReservationsService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  const locLurin = '9129b578-631e-1735-8427-b683fb524380';

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
  });

  describe('Control de concurrencia y prevención de sobreventa', () => {
    it('debe prevenir sobreventa serializando solicitudes concurrentes con bloqueo de filas', async () => {
      // ADI-RF3-GRI-38 tiene on_hand = 10, reserved = 0, available = 10 en Lurín
      // Lanzamos 5 solicitudes concurrentes pidiendo 3 unidades cada una (total solicitado: 15)
      // Capacidad máxima admitida: 3 solicitudes exitosas (9 unidades), 2 solicitudes rechazadas (1 restante)
      const sku = 'ADI-RF3-GRI-38';
      const concurrency = 5;
      const requestedQty = 3;

      const promises = Array.from({ length: concurrency }).map(
        async (_, idx) => {
          const opId = randomUUID();
          const orderId = `PED-CONCURRENCY-${idx + 1}`;
          return reservationsService.solicitarReserva(
            {
              order_id: orderId,
              operation_id: opId,
              channel_id: 'MARKETPLACE',
              lines: [{ sku, quantity: requestedQty, location_id: locLurin }],
            },
            undefined,
            opId,
          );
        },
      );

      const results = await Promise.all(promises);

      // Todas reciben 202 Accepted por admisión
      expect(results).toHaveLength(5);
      for (const res of results) {
        expect(res.status).toBe('ACCEPTED');
        expect(res.operation_type).toBe('RESERVAR');
      }

      // Verificamos el saldo final en la base de datos
      const bal = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(bal.reserved).toBe(9); // 3 solicitudes x 3 unidades
      expect(bal.available).toBe(1); // 10 - 9 = 1
      expect(bal.reserved + bal.blocked).toBeLessThanOrEqual(bal.on_hand);

      // Verificamos operaciones registradas: exactamente 3 APLICADO y 2 RECHAZADO con STOCK_INSUFICIENTE
      const successfulOps = mockDb.operations.filter(
        (o) => o.operation_type === 'RESERVA' && o.status === 'APLICADO',
      );
      const rejectedOps = mockDb.operations.filter(
        (o) => o.operation_type === 'RESERVA' && o.status === 'RECHAZADO',
      );

      expect(successfulOps).toHaveLength(3);
      expect(rejectedOps).toHaveLength(2);
      for (const rej of rejectedOps) {
        expect(rej.result_code).toBe('STOCK_INSUFICIENTE');
      }

      // Verificamos eventos Outbox: 3 creadas y 2 rechazadas
      const createdEvents = mockDb.outbox.filter(
        (e) => e.event_type === 'inventory.reservation.created',
      );
      const rejectedEvents = mockDb.outbox.filter(
        (e) => e.event_type === 'inventory.reservation.rejected',
      );

      expect(createdEvents).toHaveLength(3);
      expect(rejectedEvents).toHaveLength(2);
    });
  });

  describe('Saldo insuficiente y atomicidad (rollback)', () => {
    it('debe registrar rechazo durable y outbox cuando el saldo es insuficiente, sin mutar el stock', async () => {
      // PUM-LIMIT-01 tiene on_hand = 2 en Lurín
      const sku = 'PUM-LIMIT-01';
      const opId = randomUUID();

      const res = await reservationsService.solicitarReserva(
        {
          order_id: 'PED-INSUFFICIENT-1',
          operation_id: opId,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 5, location_id: locLurin }],
        },
        undefined,
        opId,
      );

      expect(res.status).toBe('ACCEPTED');

      // El stock no debe haber sido tocado
      const bal = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(bal.reserved).toBe(0);
      expect(bal.available).toBe(2);

      // No se crean reservas ni líneas de reserva
      expect(mockDb.reservations).toHaveLength(0);
      expect(mockDb.reservationLines).toHaveLength(0);

      // Operación registrada como RECHAZADO con STOCK_INSUFICIENTE
      const op = mockDb.operations.find((o) => o.operation_id === opId);
      expect(op).toBeDefined();
      expect(op?.status).toBe('RECHAZADO');
      expect(op?.result_code).toBe('STOCK_INSUFICIENTE');

      // Outbox con evento inventory.reservation.rejected
      const rejectedOutbox = mockDb.outbox.find((o) => o.aggregate_id === opId);
      expect(rejectedOutbox).toBeDefined();
      expect(rejectedOutbox?.event_type).toBe('inventory.reservation.rejected');
      expect(rejectedOutbox?.payload?.data?.result_code).toBe(
        'STOCK_INSUFICIENTE',
      );
    });

    it('debe aplicar atomicidad multilínea: si una línea falla, ninguna se reserva (todo o nada)', async () => {
      const skuSuficiente = 'ADI-RF3-GRI-38'; // tiene 10
      const skuInsuficiente = 'PUM-LIMIT-01'; // tiene 2
      const opId = randomUUID();

      await reservationsService.solicitarReserva(
        {
          order_id: 'PED-MULTILINE-FAIL',
          operation_id: opId,
          channel_id: 'MARKETPLACE',
          lines: [
            { sku: skuSuficiente, quantity: 4, location_id: locLurin },
            { sku: skuInsuficiente, quantity: 8, location_id: locLurin }, // Falla aquí
          ],
        },
        undefined,
        opId,
      );

      // Ningún SKU debe haberse modificado
      const bal1 = mockDb.stockBalance.find(
        (b) => b.sku_id === skuSuficiente && b.location_id === locLurin,
      )!;
      const bal2 = mockDb.stockBalance.find(
        (b) => b.sku_id === skuInsuficiente && b.location_id === locLurin,
      )!;

      expect(bal1.reserved).toBe(0);
      expect(bal2.reserved).toBe(0);

      expect(mockDb.reservations).toHaveLength(0);
      expect(mockDb.kardex).toHaveLength(0);
    });
  });

  describe('Idempotencia semántica y detección de conflictos', () => {
    it('debe responder idempotentemente sin duplicar efectos ante reintentos idénticos', async () => {
      const opId = randomUUID();
      const sku = 'ADI-RF3-GRI-38';

      const payload = {
        order_id: 'PED-IDEMPOTENT-01',
        operation_id: opId,
        channel_id: 'MARKETPLACE' as const,
        lines: [{ sku, quantity: 2, location_id: locLurin }],
      };

      // Primer llamado
      const res1 = await reservationsService.solicitarReserva(
        payload,
        undefined,
        opId,
      );
      expect(res1.status).toBe('ACCEPTED');

      const balAfterFirst = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balAfterFirst.reserved).toBe(2);
      expect(mockDb.reservations).toHaveLength(1);
      expect(mockDb.kardex).toHaveLength(1);

      // Segundo llamado: mismo operation_id, mismo contenido
      const res2 = await reservationsService.solicitarReserva(
        payload,
        undefined,
        opId,
      );
      expect(res2.status).toBe('ACCEPTED');
      expect(res2.operation_id).toBe(opId);

      // No se generaron reservas dobles ni líneas ni movimientos adicionales en Kardex
      const balAfterSecond = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(balAfterSecond.reserved).toBe(2);
      expect(mockDb.reservations).toHaveLength(1);
      expect(mockDb.kardex).toHaveLength(1);
    });

    it('debe lanzar 409 IDEMPOTENCY_CONFLICT ante reutilización de operation_id con contenido distinto', async () => {
      const opId = randomUUID();
      const sku = 'ADI-RF3-GRI-38';

      // Primer llamado con cantidad 2
      await reservationsService.solicitarReserva(
        {
          order_id: 'PED-CONFLICT-01',
          operation_id: opId,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 2, location_id: locLurin }],
        },
        undefined,
        opId,
      );

      // Segundo llamado con mismo operation_id pero cantidad 5
      await expect(
        reservationsService.solicitarReserva(
          {
            order_id: 'PED-CONFLICT-01',
            operation_id: opId,
            channel_id: 'MARKETPLACE',
            lines: [{ sku, quantity: 5, location_id: locLurin }],
          },
          undefined,
          opId,
        ),
      ).rejects.toThrow(ProblemDetailsException);

      try {
        await reservationsService.solicitarReserva(
          {
            order_id: 'PED-CONFLICT-01',
            operation_id: opId,
            channel_id: 'MARKETPLACE',
            lines: [{ sku, quantity: 5, location_id: locLurin }],
          },
          undefined,
          opId,
        );
      } catch (err) {
        const pde = err as ProblemDetailsException;
        expect(pde.problem.status).toBe(409);
        expect(pde.problem.code).toBe('IDEMPOTENCY_CONFLICT');
      }
    });
  });

  describe('Resolución de ubicaciones y validaciones de entrada', () => {
    it('debe rechazar solicitud si faltan ubicaciones unívocas y no hay ruta de cumplimiento', async () => {
      // Sin location_id y con 2 almacenes activos sin ruta comercial
      const noLocOpId = randomUUID();
      await expect(
        reservationsService.solicitarReserva(
          {
            order_id: 'PED-NO-LOC',
            operation_id: noLocOpId,
            channel_id: 'MARKETPLACE',
            lines: [{ sku: 'ADI-RF3-GRI-38', quantity: 1 }],
          },
          undefined,
          noLocOpId,
        ),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('debe lanzar 422 CANTIDAD_INVALIDA si la cantidad no es un entero positivo mayor a cero', async () => {
      const invOp1 = randomUUID();
      await expect(
        reservationsService.solicitarReserva(
          {
            order_id: 'PED-INVALID-QTY',
            operation_id: invOp1,
            channel_id: 'MARKETPLACE',
            lines: [
              { sku: 'ADI-RF3-GRI-38', quantity: 0, location_id: locLurin },
            ],
          },
          undefined,
          invOp1,
        ),
      ).rejects.toThrow(ProblemDetailsException);

      try {
        const invOp2 = randomUUID();
        await reservationsService.solicitarReserva(
          {
            order_id: 'PED-INVALID-QTY',
            operation_id: invOp2,
            channel_id: 'MARKETPLACE',
            lines: [
              { sku: 'ADI-RF3-GRI-38', quantity: -2, location_id: locLurin },
            ],
          },
          undefined,
          invOp2,
        );
      } catch (err) {
        const pde = err as ProblemDetailsException;
        expect(pde.problem.status).toBe(422);
        expect(pde.problem.code).toBe('CANTIDAD_INVALIDA');
      }
    });

    it('debe aceptar el canal VENTAS conforme a OpenAPI y contratos G6', async () => {
      const opId = randomUUID();
      const res = await reservationsService.solicitarReserva(
        {
          order_id: 'PED-VENTAS-01',
          operation_id: opId,
          channel_id: 'VENTAS',
          lines: [
            { sku: 'ADI-RF3-GRI-38', quantity: 1, location_id: locLurin },
          ],
        },
        undefined,
        opId,
      );
      expect(res.status).toBe('ACCEPTED');
      expect(res.operation_id).toBe(opId);
    });

    it('debe validar la longitud de Idempotency-Key (8 a 128 caracteres)', async () => {
      // Clave demasiado corta (< 8 caracteres)
      await expect(
        reservationsService.solicitarReserva(
          {
            order_id: 'PED-SHORT-KEY',
            operation_id: randomUUID(),
            channel_id: 'VENTAS',
            lines: [
              { sku: 'ADI-RF3-GRI-38', quantity: 1, location_id: locLurin },
            ],
          },
          undefined,
          'short',
        ),
      ).rejects.toThrow(ProblemDetailsException);

      // Clave demasiado larga (> 128 caracteres)
      const longKey = 'a'.repeat(129);
      await expect(
        reservationsService.solicitarReserva(
          {
            order_id: 'PED-LONG-KEY',
            operation_id: randomUUID(),
            channel_id: 'VENTAS',
            lines: [
              { sku: 'ADI-RF3-GRI-38', quantity: 1, location_id: locLurin },
            ],
          },
          undefined,
          longKey,
        ),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });

  describe('Casos B, E de Idempotencia y Expiración durable', () => {
    it('Caso B: misma Idempotency-Key pero distinto operation_id debe responder 409 IDEMPOTENCY_CONFLICT', async () => {
      const sharedKey = 'shared-idempotency-key-12345';
      const sku = 'ADI-RF3-GRI-38';

      // Primera operación
      await reservationsService.solicitarReserva(
        {
          order_id: 'PED-CASO-B-1',
          operation_id: randomUUID(),
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 1, location_id: locLurin }],
        },
        undefined,
        sharedKey,
      );

      // Segunda operación con distinta operation_id pero misma Idempotency-Key
      try {
        await reservationsService.solicitarReserva(
          {
            order_id: 'PED-CASO-B-2',
            operation_id: randomUUID(),
            channel_id: 'MARKETPLACE',
            lines: [{ sku, quantity: 1, location_id: locLurin }],
          },
          undefined,
          sharedKey,
        );
        expect.unreachable('Debe lanzar 409 IDEMPOTENCY_CONFLICT');
      } catch (err) {
        const pde = err as ProblemDetailsException;
        expect(pde.problem.status).toBe(409);
        expect(pde.problem.code).toBe('IDEMPOTENCY_CONFLICT');
      }
    });

    it('Caso E: reintento idéntico reproduce el ACK durable del comando rechazado sin reevaluar stock ni crear Outbox nuevo', async () => {
      const sku = 'PUM-LIMIT-01'; // Solo tiene 2
      const opId = randomUUID();
      const payload = {
        order_id: 'PED-CASO-E-REJECT',
        operation_id: opId,
        channel_id: 'MARKETPLACE' as const,
        lines: [{ sku, quantity: 10, location_id: locLurin }], // Insuficiente
      };

      // Primer llamado: es rechazada
      const res1 = await reservationsService.solicitarReserva(
        payload,
        undefined,
        opId,
      );
      expect(res1.status).toBe('ACCEPTED');

      const rejectedOutboxCount = mockDb.outbox.filter(
        (o) => o.event_type === 'inventory.reservation.rejected',
      ).length;
      expect(rejectedOutboxCount).toBe(1);

      // Segundo llamado idéntico: debe reproducir rechazo durable sin emitir otro outbox
      const res2 = await reservationsService.solicitarReserva(
        payload,
        undefined,
        opId,
      );
      expect(res2.status).toBe('ACCEPTED');
      expect(res2.operation_id).toBe(opId);
      expect(res2).toEqual(res1);

      const rejectedOutboxCount2 = mockDb.outbox.filter(
        (o) => o.event_type === 'inventory.reservation.rejected',
      ).length;
      expect(rejectedOutboxCount2).toBe(1); // No aumentó
    });

    it('Expiración durable: reserva vencida debe transicionar a EXPIRADA de manera durable y no sufrir rollback', async () => {
      const sku = 'ADI-RF3-GRI-38';
      const opId = randomUUID();

      // 1. Crear reserva exitosa
      await reservationsService.solicitarReserva(
        {
          order_id: 'PED-EXPIRATION-DURABLE',
          operation_id: opId,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 3, location_id: locLurin }],
        },
        undefined,
        opId,
      );

      const reserva = mockDb.reservations.find(
        (r) => r.order_id === 'PED-EXPIRATION-DURABLE',
      )!;
      expect(reserva.status).toBe('ACTIVA');

      // Forzar vencimiento (expires_at en el pasado)
      reserva.expires_at = new Date(Date.now() - 60000).toISOString();

      // 2. Intentar confirmar reserva expirada
      const confirmOpId = randomUUID();
      try {
        await reservationsService.confirmarReserva(
          reserva.reservation_id,
          {
            order_id: 'PED-EXPIRATION-DURABLE',
            operation_id: confirmOpId,
          },
          undefined,
          confirmOpId,
        );
        expect.unreachable('Debe lanzar RESERVA_EXPIRADA');
      } catch (err) {
        const pde = err as ProblemDetailsException;
        expect(pde.problem.status).toBe(409);
        expect(pde.problem.code).toBe('RESERVA_EXPIRADA');
      }

      // 3. Verificar persistencia durable de la expiración:
      // La reserva DEBE haber quedado en estado EXPIRADA en la base de datos (NO ACTIVA)
      const reservaFinal = mockDb.reservations.find(
        (r) => r.reservation_id === reserva.reservation_id,
      )!;
      expect(reservaFinal.status).toBe('EXPIRADA');

      // El saldo reservado fue liberado (reserved vuelve a 0)
      const bal = mockDb.stockBalance.find(
        (b) => b.sku_id === sku && b.location_id === locLurin,
      )!;
      expect(bal.reserved).toBe(0);

      // Se registró movimiento en Kardex de tipo EXPIRACION
      const kardexExp = mockDb.kardex.find(
        (k) =>
          k.reservation_id === reserva.reservation_id &&
          k.operation_type === 'EXPIRACION',
      );
      expect(kardexExp).toBeDefined();

      // Se encoló el evento inventory.reservation.expired en Outbox
      const outboxExp = mockDb.outbox.find(
        (o) =>
          o.event_type === 'inventory.reservation.expired' &&
          o.aggregate_id === reserva.reservation_id,
      );
      expect(outboxExp).toBeDefined();
    });
  });
});
