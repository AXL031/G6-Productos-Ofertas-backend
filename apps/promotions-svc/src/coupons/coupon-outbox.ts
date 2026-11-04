import { couponContracts } from './coupon-contract.generated.js';
import type { CouponResult } from './coupon-command.js';
import { matchesSchema } from './schema-validator.js';
import type { SqlPool } from './coupon-transactions.js';

export interface ConfirmedResultPublisher {
  publishConfirmed(result: CouponResult): Promise<void>;
}

export class CouponOutbox {
  constructor(
    private readonly pool: SqlPool,
    private readonly publisher: ConfirmedResultPublisher,
  ) {}

  async publishOne(): Promise<'empty' | 'published' | 'pending'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const selected =
        await client.query(`SELECT message_id,schema_version,occurred_at,correlation_id,
        causation_id,operation_id,producer,kind,name,data FROM promotions.outbox
        WHERE published_at IS NULL AND name IN
        ('promotions.coupon.consumption.completed','promotions.coupon.consumption.rejected',
         'promotions.coupon.restoration.completed','promotions.coupon.restoration.rejected')
        ORDER BY created_at,message_id FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!selected.rows[0]) {
        await client.query('COMMIT');
        return 'empty';
      }
      const row = selected.rows[0];
      const result = {
        ...row,
        occurred_at:
          row.occurred_at instanceof Date
            ? row.occurred_at.toISOString()
            : row.occurred_at,
      };
      const contract =
        typeof row.name === 'string' ? couponContracts[row.name] : undefined;
      if (!contract || !matchesSchema(result, contract.schema))
        throw new Error('INVALID_OUTBOX_RESULT');
      await client.query(
        'UPDATE promotions.outbox SET attempts=attempts+1 WHERE message_id=$1',
        [row.message_id],
      );
      let published = false;
      try {
        await this.publisher.publishConfirmed(
          result as unknown as CouponResult,
        );
        published = true;
      } catch {
        await client.query(
          "UPDATE promotions.outbox SET last_error='PUBLISH_NOT_CONFIRMED' WHERE message_id=$1",
          [row.message_id],
        );
      }
      if (published)
        await client.query(
          'UPDATE promotions.outbox SET published_at=clock_timestamp(),last_error=NULL WHERE message_id=$1',
          [row.message_id],
        );
      await client.query('COMMIT');
      return published ? 'published' : 'pending';
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error('COUPON_OUTBOX_FAILED');
    } finally {
      client.release();
    }
  }
}
