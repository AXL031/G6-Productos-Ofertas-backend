import { IDatabaseClient } from '../../database/database.interface.js';
import { OutboxRecord } from '../../outbox/outbox.service.js';

export interface OutboxEntity {
  id: string;
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id?: string | null;
  payload: any;
  status: 'PENDING' | 'PUBLISHED';
  published_at?: string | null;
  created_at?: string;
}

export interface IOutboxRepository {
  enqueue(client: IDatabaseClient, record: OutboxRecord): Promise<void>;

  findPendingForUpdateSkipLocked(
    client: IDatabaseClient,
    limit: number,
  ): Promise<OutboxEntity[]>;

  findPending(limit: number): Promise<OutboxEntity[]>;

  markAsPublished(id: string, client?: IDatabaseClient): Promise<void>;
}
