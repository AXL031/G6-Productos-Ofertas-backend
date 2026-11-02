import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventorySvcModule } from '../inventory-svc.module.js';
import { DatabaseService } from '../database/database.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { OutboxService } from './outbox.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('Snapshots de saldo en Outbox — transacciones simuladas (#102)', () => {
  let reservations: ReservationsService;
  let outbox: OutboxService;
  let db: InMemoryDatabaseMock;
  const sku = 'NIK-REV7-NEG-41';
  const location = '9129b578-631e-1735-8427-b683fb524380';
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [InventorySvcModule],
    }).compile();
    db = new InMemoryDatabaseMock();
    module.get(DatabaseService).setCustomService(db);
    reservations = module.get(ReservationsService);
    outbox = module.get(OutboxService);
  });

  it.each(['confirmar', 'liberar', 'expirar'] as const)(
    'publica el saldo completo al reservar y %s, con versión creciente y sin repetir efectos',
    async (action) => {
      const operation = randomUUID();
      const order = randomUUID();
      const correlation = randomUUID();
      const initial = structuredClone(
        db.stockBalance.find(
          (row) => row.sku_id === sku && row.location_id === location,
        )!,
      );
      await reservations.solicitarReserva(
        {
          order_id: order,
          operation_id: operation,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 2, location_id: location }],
        },
        correlation,
        operation,
      );
      const reservation = db.reservations[0];
      const nextOperation = randomUUID();
      const finish = async () => {
        if (action === 'confirmar')
          await reservations.confirmarReserva(
            reservation.reservation_id,
            { order_id: order, operation_id: nextOperation },
            correlation,
            nextOperation,
          );
        else if (action === 'liberar')
          await reservations.liberarReserva(
            reservation.reservation_id,
            {
              order_id: order,
              operation_id: nextOperation,
              reason: 'ANULACION',
            },
            correlation,
            nextOperation,
          );
        else
          await reservations.expirarReservaDurable(
            reservation.reservation_id,
            order,
            correlation,
          );
      };
      if (action === 'expirar')
        reservation.expires_at = new Date(Date.now() - 1000).toISOString();
      await finish();
      const snapshots = db.outbox.filter(
        (row) => row.event_type === 'inventory.stock.changed',
      );
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].payload).toMatchObject({
        correlation_id: correlation,
        operation_id: operation,
        data: {
          sku,
          location_id: location,
          on_hand: initial.on_hand,
          reserved: initial.reserved + 2,
          blocked: initial.blocked,
          available: initial.on_hand - initial.reserved - initial.blocked - 2,
          stock_version: initial.stock_version + 1,
          estado: expect.any(String),
          updated_at: expect.any(String),
        },
      });
      const final = db.stockBalance.find(
        (row) => row.sku_id === sku && row.location_id === location,
      )!;
      expect(snapshots[1].payload.data).toMatchObject({
        on_hand: final.on_hand,
        reserved: final.reserved,
        blocked: final.blocked,
        available: final.available,
        stock_version: initial.stock_version + 2,
      });
      const count = db.outbox.length;
      await finish();
      expect(db.outbox).toHaveLength(count);
    },
  );

  it('si falla el snapshot, revierte la reserva y el saldo junto con todos los registros Outbox', async () => {
    const before = structuredClone(db.stockBalance);
    const operation = randomUUID();
    vi.spyOn(outbox, 'stockChanged').mockRejectedValueOnce(
      new Error('snapshot no persistido'),
    );
    await expect(
      reservations.solicitarReserva(
        {
          order_id: randomUUID(),
          operation_id: operation,
          channel_id: 'MARKETPLACE',
          lines: [{ sku, quantity: 2, location_id: location }],
        },
        randomUUID(),
        operation,
      ),
    ).rejects.toThrow();
    expect(db.stockBalance).toEqual(before);
    expect(db.reservations).toHaveLength(0);
    expect(db.operations).toHaveLength(0);
    expect(db.kardex).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });
});
