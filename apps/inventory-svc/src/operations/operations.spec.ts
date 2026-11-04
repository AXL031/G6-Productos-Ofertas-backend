import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OperationsService } from './operations.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import { DrizzleOperationsRepository } from '../repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleReservationsRepository } from '../repositories/drizzle/drizzle-reservations.repository.js';

describe('OperationsService — Consulta Durable de Operaciones G5', () => {
  let operationsService: OperationsService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);

    const operationsRepo = new DrizzleOperationsRepository(dbService);
    const reservationsRepo = new DrizzleReservationsRepository(dbService);
    operationsService = new OperationsService(operationsRepo, reservationsRepo);
  });

  it('debe recuperar el estado persistido de una operación completada', async () => {
    const opId = randomUUID();
    const resId = randomUUID();
    const orderId = 'PED-OPS-01';

    mockDb.reservations.push({
      id: 'res-1',
      reservation_id: resId,
      status: 'ACTIVA',
      expires_at: new Date(Date.now() + 900000).toISOString(),
      idempotency_key: opId,
      intention: 'reservar',
      order_id: orderId,
      operation_id: opId,
    });

    mockDb.operations.push({
      id: 'op-1',
      operation_id: opId,
      order_id: orderId,
      operation_type: 'RESERVA',
      status: 'APLICADO',
      reservation_id: resId,
      idempotency_key: opId,
      intention: 'reservar',
      accepted_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
    });

    const res = await operationsService.consultarOperacion(opId);

    expect(res.operation_id).toBe(opId);
    expect(res.order_id).toBe(orderId);
    expect(res.operation_type).toBe('RESERVAR');
    expect(res.status).toBe('COMPLETED');
    expect(res.reservation_id).toBe(resId);
    expect(res.expires_at).toBeDefined();
    expect(res.completed_at).toBeDefined();
  });

  it('debe recuperar el estado persistido de una operación rechazada con su result_code', async () => {
    const opId = randomUUID();
    const orderId = 'PED-REJECT-01';

    mockDb.operations.push({
      id: 'op-2',
      operation_id: opId,
      order_id: orderId,
      operation_type: 'RESERVA',
      status: 'RECHAZADO',
      result_code: 'STOCK_INSUFICIENTE',
      idempotency_key: opId,
      intention: 'reservar',
      accepted_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
    });

    const res = await operationsService.consultarOperacion(opId);

    expect(res.operation_id).toBe(opId);
    expect(res.order_id).toBe(orderId);
    expect(res.status).toBe('REJECTED');
    expect(res.result_code).toBe('STOCK_INSUFICIENTE');
  });

  it('debe lanzar 404 OPERACION_INVENTARIO_NO_ENCONTRADA si la operación no existe', async () => {
    const unknownId = randomUUID();
    try {
      await operationsService.consultarOperacion(unknownId);
      expect.unreachable('Debe lanzar 404');
    } catch (err) {
      const pde = err as ProblemDetailsException;
      expect(pde.problem.status).toBe(404);
      expect(pde.problem.code).toBe('OPERACION_INVENTARIO_NO_ENCONTRADA');
    }
  });

  it('debe lanzar 400 VALIDACION si el operationId no es un UUID válido', async () => {
    try {
      await operationsService.consultarOperacion('not-a-uuid');
      expect.unreachable('Debe lanzar 400');
    } catch (err) {
      const pde = err as ProblemDetailsException;
      expect(pde.problem.status).toBe(400);
      expect(pde.problem.code).toBe('VALIDACION');
    }
  });

  it.each([
    { status: 'RECIBIDO', result_code: null, expected: 'ACCEPTED' },
    { status: 'APLICADO', result_code: null, expected: 'COMPLETED' },
    {
      status: 'RECHAZADO',
      result_code: 'STOCK_INSUFICIENTE',
      expected: 'REJECTED',
    },
    {
      status: 'REQUIRES_REVIEW',
      result_code: null,
      expected: 'REQUIRES_REVIEW',
    },
  ])(
    'consulta $status sin mutar ni confundirlo con otro estado',
    async ({ status, result_code, expected }) => {
      const operationId = randomUUID();
      mockDb.operations.push({
        id: randomUUID(),
        operation_id: operationId,
        order_id: 'PED-OPACO-001',
        operation_type: 'RESERVA',
        status,
        result_code,
        idempotency_key: randomUUID(),
        intention: 'reservar',
        accepted_at: new Date().toISOString(),
      });
      const before = structuredClone(mockDb.operations);
      const result = await operationsService.consultarOperacion(operationId);
      expect(result.status).toBe(expected);
      expect(result.order_id).toBe('PED-OPACO-001');
      expect(result).not.toHaveProperty('on_hand');
      expect(mockDb.operations).toEqual(before);
    },
  );

  it.each([
    { status: 'RECHAZADO', result_code: null },
    { status: 'RECHAZADO', result_code: '   ' },
    { accepted_at: 'fecha-no-valida' },
    { applied_at: 'fecha-no-valida' },
    { order_id: '   ' },
  ])(
    'no emite una respuesta contractual inválida para una operación histórica: %j',
    async (override) => {
      const operationId = randomUUID();
      mockDb.operations.push({
        id: randomUUID(),
        operation_id: operationId,
        order_id: 'PED-HISTORICO',
        operation_type: 'RESERVA',
        status: 'APLICADO',
        idempotency_key: randomUUID(),
        intention: 'reservar',
        accepted_at: new Date().toISOString(),
        ...override,
      });
      await expect(
        operationsService.consultarOperacion(operationId),
      ).rejects.toMatchObject({
        problem: { status: 404, code: 'OPERACION_INVENTARIO_NO_ENCONTRADA' },
      });
    },
  );
});
