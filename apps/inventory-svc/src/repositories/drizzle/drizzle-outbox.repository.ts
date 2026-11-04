import { Injectable } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import { OutboxRecord } from '../../outbox/outbox.service.js';
import * as schema from '../../drizzle/schema.js';
import {
  IOutboxRepository,
  OutboxEntity,
} from '../interfaces/outbox.repository.interface.js';

@Injectable()
export class DrizzleOutboxRepository implements IOutboxRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async enqueue(client: IDatabaseClient, record: OutboxRecord): Promise<void> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      await db.insert(schema.outbox).values({
        event_id: record.event_id,
        event_type: record.event_type,
        aggregate_type: record.aggregate_type,
        aggregate_id: record.aggregate_id,
        correlation_id: record.correlation_id ?? undefined,
        payload: record.payload,
        status: 'PENDING',
      });
      return;
    }

    const querySql = `
      INSERT INTO inventory.outbox (
        event_id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
    `;
    await client.query(querySql, [
      record.event_id,
      record.event_type,
      record.aggregate_type,
      record.aggregate_id,
      record.correlation_id ?? null,
      JSON.stringify(record.payload),
    ]);
  }

  async findPendingForUpdateSkipLocked(
    client: IDatabaseClient,
    limit: number,
  ): Promise<OutboxEntity[]> {
    // Reclamación transaccional segura con FOR UPDATE SKIP LOCKED
    const querySql = `
      SELECT id, event_id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, created_at
      FROM inventory.outbox
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;
    const res = await client.query(querySql, [limit]);
    return res.rows.map(this.mapRow);
  }

  async findPending(limit: number): Promise<OutboxEntity[]> {
    const db = this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.status, 'PENDING'))
        .orderBy(asc(schema.outbox.created_at))
        .limit(limit);
      return rows.map(this.mapRow);
    }

    const querySql = `
      SELECT id, event_id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, created_at
      FROM inventory.outbox
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT $1
    `;
    const res = await this.databaseService.query(querySql, [limit]);
    return res.rows.map(this.mapRow);
  }

  async markAsPublished(id: string, client?: IDatabaseClient): Promise<void> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const updated = await db
        .update(schema.outbox)
        .set({
          status: 'PUBLISHED',
          published_at: new Date(),
        })
        .where(eq(schema.outbox.id, id))
        .returning({ id: schema.outbox.id });
      if (updated.length !== 1) {
        throw new Error(
          `Integridad Outbox: actualización PUBLISHED afectó ${updated.length} filas para ${id}`,
        );
      }
      return;
    }

    const querySql = `
      UPDATE inventory.outbox
      SET status = 'PUBLISHED', published_at = now()
      WHERE id = $1
    `;
    const result = client
      ? await client.query(querySql, [id])
      : await this.databaseService.query(querySql, [id]);
    if (result.rowCount !== 1) {
      throw new Error(
        `Integridad Outbox: actualización PUBLISHED afectó ${result.rowCount ?? 0} filas para ${id}`,
      );
    }
  }

  private mapRow(r: any): OutboxEntity {
    return {
      id: r.id,
      event_id: r.event_id,
      event_type: r.event_type,
      aggregate_type: r.aggregate_type,
      aggregate_id: r.aggregate_id,
      correlation_id: r.correlation_id,
      payload:
        typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      status: r.status,
      created_at: r.created_at,
    };
  }
}
