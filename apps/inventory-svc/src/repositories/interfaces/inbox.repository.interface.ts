import { IDatabaseClient } from '../../database/database.interface.js';

export interface InboxEntity {
  id: string;
  message_id: string;
  message_type: string;
  source: string;
  payload: unknown;
  status: 'RECEIVED' | 'PROCESSED';
  processed_at?: string | null;
  created_at?: string | null;
}

export interface IInboxRepository {
  /** Busca un mensaje entrante por su message_id para deduplicación. */
  findByMessageId(
    messageId: string,
    client?: IDatabaseClient,
  ): Promise<InboxEntity | null>;

  /** Registra el mensaje entrante como RECEIVED (idempotente por message_id). */
  register(
    client: IDatabaseClient,
    message: {
      message_id: string;
      message_type: string;
      source: string;
      payload: unknown;
    },
  ): Promise<InboxEntity>;

  /** Marca el mensaje como PROCESSED tras aplicarlo. */
  markProcessed(client: IDatabaseClient, messageId: string): Promise<void>;
}
