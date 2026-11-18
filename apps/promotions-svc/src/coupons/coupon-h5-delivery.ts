import { randomUUID } from 'node:crypto';
import type {
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from '@azure/service-bus';
import {
  inPromotionsTransaction,
  type SqlPool,
} from '../infrastructure/persistence/sql-transaction.js';
import { parseCouponCommand, type CouponCommand } from './coupon-command.js';
import { couponH5Queue, type CouponH5Worker } from './coupon-h5-operations.js';

export interface CouponH5Claim {
  token: string;
  messageId: string;
  command: CouponCommand;
}

export class CouponH5DeliveryStore {
  constructor(private readonly pool: SqlPool) {}

  claim(): Promise<CouponH5Claim | undefined> {
    return inPromotionsTransaction(this.pool, async (client) => {
      const selected =
        await client.query(`SELECT d.message_id,o.command FROM promotions.h5_coupon_outbox d
        JOIN promotions.h5_coupon_operations o ON o.operation_id=d.operation_id AND o.message_id=d.message_id
        WHERE d.sent_at IS NULL AND d.next_attempt_at<=clock_timestamp()
          AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp())
        ORDER BY d.next_attempt_at,d.created_at,d.message_id FOR UPDATE OF d SKIP LOCKED LIMIT 1`);
      const row = selected.rows[0];
      if (!row) return undefined;
      const command = parseCouponCommand(row.command, 'modulo-ventas');
      const token = randomUUID();
      await client.query(
        `UPDATE promotions.h5_coupon_outbox SET lease_token=$2,
        lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1 WHERE message_id=$1`,
        [row.message_id, token],
      );
      return { token, messageId: String(row.message_id), command };
    });
  }

  finish(
    claim: CouponH5Claim,
    outcome: 'sent' | 'pending' | 'too-large',
  ): Promise<boolean> {
    return inPromotionsTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE promotions.h5_coupon_outbox SET
        sent_at=CASE WHEN $3='sent' THEN clock_timestamp() ELSE NULL END,
        next_attempt_at=CASE WHEN $3='too-large' THEN 'infinity'::timestamptz
          WHEN $3='pending' THEN clock_timestamp()+make_interval(secs=>LEAST(60,power(2,LEAST(attempts,6))::int))
          ELSE next_attempt_at END,
        last_error=CASE WHEN $3='sent' THEN NULL WHEN $3='too-large' THEN 'MESSAGE_TOO_LARGE' ELSE 'SEND_NOT_CONFIRMED' END,
        lease_token=NULL,lease_until=NULL
        WHERE message_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND sent_at IS NULL RETURNING message_id`,
        [claim.messageId, claim.token, outcome],
      );
      return result.rows.length === 1;
    });
  }
}

export class CouponH5Relay {
  constructor(
    private readonly store: Pick<CouponH5DeliveryStore, 'claim' | 'finish'>,
    private readonly sender: Pick<
      ServiceBusSender,
      'createMessageBatch' | 'sendMessages'
    >,
  ) {}

  async publishOne(): Promise<
    'empty' | 'sent' | 'pending' | 'too-large' | 'lease-lost'
  > {
    const claim = await this.store.claim();
    if (!claim) return 'empty';
    let outcome: 'sent' | 'pending' | 'too-large' = 'pending';
    try {
      const batch = await this.sender.createMessageBatch({
        maxSizeInBytes: 256 * 1024,
      });
      if (
        !batch.tryAddMessage({
          body: Buffer.from(JSON.stringify(claim.command)),
          messageId: claim.messageId,
          correlationId: claim.command.correlation_id,
          subject: claim.command.name,
          contentType: 'application/json',
          applicationProperties: {
            producer: 'promotions-svc',
            schema_version: 2,
            route_version: 1,
            admitted_client: 'modulo-ventas',
          },
        })
      )
        outcome = 'too-large';
      else {
        await this.sender.sendMessages(batch, {
          abortSignal: AbortSignal.timeout(10_000),
        });
        outcome = 'sent';
      }
    } catch {
      /* Ambiguous send retains the same MessageId and pending intent. */
    }
    return (await this.store.finish(claim, outcome)) ? outcome : 'lease-lost';
  }
}

export interface CouponH5Settlement {
  completeMessage(message: ServiceBusReceivedMessage): Promise<void>;
  abandonMessage(message: ServiceBusReceivedMessage): Promise<void>;
  deadLetterMessage(
    message: ServiceBusReceivedMessage,
    options: { deadLetterReason: string; deadLetterErrorDescription: string },
  ): Promise<void>;
}

// Construct only for the internally owned queue after validating its Sender/
// Receiver ACLs. No G5 connection or claim in the wire body grants queue access.
export class CouponH5DeliveryHandler {
  constructor(
    queue: string,
    private readonly worker: Pick<CouponH5Worker, 'process'>,
    private readonly settlement: CouponH5Settlement,
  ) {
    if (queue !== couponH5Queue) throw new Error('INVALID_COUPON_H5_QUEUE');
  }

  async handle(message: ServiceBusReceivedMessage): Promise<void> {
    let command: CouponCommand;
    try {
      if (
        !(message.body instanceof Uint8Array) ||
        message.body.length > 256 * 1024 ||
        message.contentType !== 'application/json' ||
        message.applicationProperties?.producer !== 'promotions-svc' ||
        message.applicationProperties?.admitted_client !== 'modulo-ventas' ||
        message.applicationProperties?.schema_version !== 2 ||
        message.applicationProperties?.route_version !== 1
      )
        throw new Error();
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(message.body),
      );
      command = parseCouponCommand(value, 'modulo-ventas');
      if (
        message.messageId !== command.message_id ||
        message.subject !== command.name ||
        message.correlationId !== command.correlation_id
      )
        throw new Error();
    } catch {
      await this.settlement.deadLetterMessage(message, {
        deadLetterReason: 'INVALID_COUPON_H5_COMMAND',
        deadLetterErrorDescription: 'Contract or route validation failed',
      });
      return;
    }
    try {
      await this.worker.process(command);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'INVALID_COUPON_H5_COMMAND'
      )
        await this.settlement.deadLetterMessage(message, {
          deadLetterReason: 'UNADMITTED_COUPON_H5_COMMAND',
          deadLetterErrorDescription: 'No matching durable admission',
        });
      else await this.settlement.abandonMessage(message);
      return;
    }
    // Do not abandon/deadletter a committed business operation if settlement fails.
    await this.settlement.completeMessage(message);
  }
}
