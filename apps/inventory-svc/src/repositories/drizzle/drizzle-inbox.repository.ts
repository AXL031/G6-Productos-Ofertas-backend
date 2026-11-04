import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import {
  IInboxRepository,
  InboxEntity,
} from '../interfaces/inbox.repository.interface.js';

const COLUMNS = `
  id, message_id, message_type, source, payload, status, processed_at, created_at
`;

@Injectable()
export class DrizzleInboxRepository implements IInboxRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  private mapRow(
    row: Omit<InboxEntity, 'processed_at' | 'created_at'> & {
      processed_at?: string | Date | null;
      created_at?: string | Date | null;
    },
  ): InboxEntity {
    return {
      id: row.id,
      message_id: row.message_id,
      message_type: row.message_type,
      source: row.source,
      payload:
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      processed_at:
        row.processed_at instanceof Date
          ? row.processed_at.toISOString()
          : (row.processed_at ?? null),
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
    };
  }

  async findByMessageId(
    messageId: string,
    client?: IDatabaseClient,
  ): Promise<InboxEntity | null> {
    const sql = `SELECT ${COLUMNS} FROM inventory.inbox WHERE message_id = $1`;
    const res = client
      ? await client.query<InboxEntity>(sql, [messageId])
      : await this.databaseService.query<InboxEntity>(sql, [messageId]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async register(
    client: IDatabaseClient,
    message: {
      message_id: string;
      message_type: string;
      source: string;
      payload: unknown;
    },
  ): Promise<InboxEntity> {
    const sql = `
      INSERT INTO inventory.inbox (message_id, message_type, source, payload, status)
      VALUES ($1, $2, $3, $4, 'RECEIVED')
      ON CONFLICT (message_id) DO NOTHING
      RETURNING ${COLUMNS}
    `;
    const res = await client.query<InboxEntity>(sql, [
      message.message_id,
      message.message_type,
      message.source,
      JSON.stringify(message.payload),
    ]);
    if (res.rows[0]) return this.mapRow(res.rows[0]);
    const existing = await this.findByMessageId(message.message_id, client);
    if (!existing)
      throw new Error('No fue posible recuperar el mensaje Inbox registrado');
    return existing;
  }

  async markProcessed(
    client: IDatabaseClient,
    messageId: string,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE inventory.inbox
         SET status = 'PROCESSED', processed_at = now()
       WHERE message_id = $1`,
      [messageId],
    );
    if (result.rowCount !== 1)
      throw new Error('El marcado Inbox no afectó exactamente un mensaje');
  }
}
