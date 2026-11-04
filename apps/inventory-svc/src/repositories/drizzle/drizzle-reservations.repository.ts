import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import * as schema from '../../drizzle/schema.js';
import {
  IReservationsRepository,
  ReservationEntity,
  ReservationLineEntity,
} from '../interfaces/reservations.repository.interface.js';

@Injectable()
export class DrizzleReservationsRepository implements IReservationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findById(
    id: string,
    client?: IDatabaseClient,
  ): Promise<ReservationEntity | null> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select()
        .from(schema.reservations)
        .where(eq(schema.reservations.id, id));
      if (rows.length === 0) return null;
      return this.mapRow(rows[0]);
    }

    const querySql = `
      SELECT id, reservation_id, status, expires_at, idempotency_key, intention,
             correlation_id, order_id, operation_id, consumed_at, released_at, expired_at,
             request_fingerprint, accepted_payload
      FROM inventory.reservations
      WHERE id = $1
    `;
    const res = client
      ? await client.query(querySql, [id])
      : await this.databaseService.query(querySql, [id]);

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByIdForUpdate(
    client: IDatabaseClient,
    id: string,
  ): Promise<ReservationEntity | null> {
    // Operación crítica con FOR UPDATE
    const querySql = `
      SELECT id, reservation_id, status, expires_at, idempotency_key, intention,
             correlation_id, order_id, operation_id, consumed_at, released_at, expired_at,
             request_fingerprint, accepted_payload
      FROM inventory.reservations
      WHERE id = $1
      FOR UPDATE
    `;
    const res = await client.query(querySql, [id]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByReservationId(
    reservationId: string,
    client?: IDatabaseClient,
  ): Promise<ReservationEntity | null> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select()
        .from(schema.reservations)
        .where(eq(schema.reservations.reservation_id, reservationId));
      if (rows.length === 0) return null;
      return this.mapRow(rows[0]);
    }

    const querySql = `
      SELECT id, reservation_id, status, expires_at, idempotency_key, intention,
             correlation_id, order_id, operation_id, consumed_at, released_at, expired_at,
             request_fingerprint, accepted_payload
      FROM inventory.reservations
      WHERE reservation_id = $1
    `;
    const res = client
      ? await client.query(querySql, [reservationId])
      : await this.databaseService.query(querySql, [reservationId]);

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByReservationIdForUpdate(
    client: IDatabaseClient,
    reservationId: string,
  ): Promise<ReservationEntity | null> {
    // Operación crítica con FOR UPDATE
    const querySql = `
      SELECT id, reservation_id, status, expires_at, idempotency_key, intention,
             correlation_id, order_id, operation_id, consumed_at, released_at, expired_at,
             request_fingerprint, accepted_payload
      FROM inventory.reservations
      WHERE reservation_id = $1
      FOR UPDATE
    `;
    const res = await client.query(querySql, [reservationId]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async create(
    client: IDatabaseClient,
    reservation: {
      reservation_id: string;
      status: 'ACTIVA' | 'CONSUMIDA' | 'LIBERADA' | 'EXPIRADA';
      expires_at: string;
      idempotency_key: string;
      intention: string;
      correlation_id?: string | null;
      order_id?: string | null;
      operation_id?: string | null;
      request_fingerprint?: string | null;
      accepted_payload?: string | null;
    },
  ): Promise<string> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const inserted = await db
        .insert(schema.reservations)
        .values({
          reservation_id: reservation.reservation_id,
          status: reservation.status,
          expires_at: new Date(reservation.expires_at),
          idempotency_key: reservation.idempotency_key,
          intention: reservation.intention,
          correlation_id: reservation.correlation_id ?? undefined,
          order_id: reservation.order_id ?? undefined,
          operation_id: reservation.operation_id ?? undefined,
          request_fingerprint: reservation.request_fingerprint ?? undefined,
          accepted_payload: reservation.accepted_payload
            ? typeof reservation.accepted_payload === 'string'
              ? JSON.parse(reservation.accepted_payload)
              : reservation.accepted_payload
            : undefined,
        })
        .returning({ id: schema.reservations.id });

      return inserted[0].id;
    }

    const querySql = `
      INSERT INTO inventory.reservations (
        reservation_id, status, expires_at, idempotency_key, intention,
        correlation_id, order_id, operation_id, request_fingerprint, accepted_payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;
    const res = await client.query(querySql, [
      reservation.reservation_id,
      reservation.status,
      reservation.expires_at,
      reservation.idempotency_key,
      reservation.intention,
      reservation.correlation_id ?? null,
      reservation.order_id ?? null,
      reservation.operation_id ?? null,
      reservation.request_fingerprint ?? null,
      reservation.accepted_payload ?? null,
    ]);

    return res.rows[0].id;
  }

  async createLines(
    client: IDatabaseClient,
    lines: Array<{
      reservation_id: string;
      sku_id: string;
      location_id: string;
      quantity: number;
    }>,
  ): Promise<void> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db && lines.length > 0) {
      await db.insert(schema.reservationLines).values(
        lines.map((l) => ({
          reservation_id: l.reservation_id,
          sku_id: l.sku_id,
          location_id: l.location_id,
          quantity: l.quantity,
        })),
      );
      return;
    }

    for (const line of lines) {
      const querySql = `
        INSERT INTO inventory.reservation_lines (
          reservation_id, sku_id, location_id, quantity
        ) VALUES ($1, $2, $3, $4)
      `;
      await client.query(querySql, [
        line.reservation_id,
        line.sku_id,
        line.location_id,
        line.quantity,
      ]);
    }
  }

  async findLinesByReservationPk(
    client: IDatabaseClient,
    reservationPk: string,
  ): Promise<ReservationLineEntity[]> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select()
        .from(schema.reservationLines)
        .where(eq(schema.reservationLines.reservation_id, reservationPk));
      return rows.map((r) => ({
        id: r.id,
        reservation_id: r.reservation_id,
        sku_id: r.sku_id,
        location_id: r.location_id,
        quantity: Number(r.quantity),
      }));
    }

    const querySql = `
      SELECT id, reservation_id, sku_id, location_id, quantity
      FROM inventory.reservation_lines
      WHERE reservation_id = $1
    `;
    const res = await client.query(querySql, [reservationPk]);
    return res.rows.map((r: any) => ({
      id: r.id,
      reservation_id: r.reservation_id,
      sku_id: r.sku_id,
      location_id: r.location_id,
      quantity: Number(r.quantity),
    }));
  }

  async updateStatus(
    client: IDatabaseClient,
    reservationPk: string,
    status: 'CONSUMIDA' | 'LIBERADA' | 'EXPIRADA',
  ): Promise<number> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const setObj: Record<string, any> = {
        status,
        updated_at: new Date(),
      };
      if (status === 'CONSUMIDA') setObj.consumed_at = new Date();
      if (status === 'LIBERADA') setObj.released_at = new Date();
      if (status === 'EXPIRADA') setObj.expired_at = new Date();

      const updated = await db
        .update(schema.reservations)
        .set(setObj)
        .where(eq(schema.reservations.id, reservationPk))
        .returning({ id: schema.reservations.id });
      return updated.length;
    }

    let dateField = 'consumed_at';
    if (status === 'LIBERADA') dateField = 'released_at';
    if (status === 'EXPIRADA') dateField = 'expired_at';

    const querySql = `
      UPDATE inventory.reservations
      SET status = $1, ${dateField} = now()
      WHERE id = $2
    `;
    const res = await client.query(querySql, [status, reservationPk]);
    return res.rowCount;
  }

  private mapRow(row: any): ReservationEntity {
    return {
      id: row.id,
      reservation_id: row.reservation_id,
      status: row.status,
      expires_at:
        typeof row.expires_at === 'string'
          ? row.expires_at
          : (row.expires_at?.toISOString?.() ?? row.expires_at),
      idempotency_key: row.idempotency_key,
      intention: row.intention,
      correlation_id: row.correlation_id,
      order_id: row.order_id,
      operation_id: row.operation_id,
      consumed_at: row.consumed_at,
      released_at: row.released_at,
      expired_at: row.expired_at,
      request_fingerprint: row.request_fingerprint,
      accepted_payload: row.accepted_payload,
    };
  }
}
