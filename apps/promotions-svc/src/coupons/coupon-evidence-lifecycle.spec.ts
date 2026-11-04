import { randomUUID } from 'node:crypto';
import {
  CouponCommandProcessor,
  type ConsumptionEvidence,
  type CouponEvidenceProvider,
  type SqlClient,
} from './coupon-transactions.js';
import { consumptionName } from './coupon-command.js';

function fixture() {
  const command = {
    message_id: randomUUID(),
    schema_version: 2,
    operation_id: randomUUID(),
    occurred_at: '2026-10-16T12:00:00Z',
    correlation_id: 'test',
    causation_id: 'order',
    producer: 'modulo-ventas',
    kind: 'command',
    name: consumptionName,
    data: {
      order_id: 'OPAQUE-ORDER',
      coupon_code: 'CODE',
      channel_id: 'MARKETPLACE',
      reservation_id: randomUUID(),
      commercial_snapshot_ref: 'snapshot',
      effective_at: '2026-10-16T12:00:00Z',
    },
  };
  const proof: ConsumptionEvidence = {
    orderId: command.data.order_id,
    reservationId: command.data.reservation_id,
    commercialSnapshotRef: 'snapshot',
    reservationConfirmed: true,
    snapshotDurable: true,
    eligible: true,
  };
  const queries: string[] = [];
  const release = vi.fn();
  const client: SqlClient = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('fn_begin_inbox')) return { rows: [{ fresh: true }] };
      if (sql.includes('SELECT id FROM promotions.coupons'))
        return { rows: [{ id: randomUUID() }] };
      if (sql.includes('fn_consume_coupon'))
        return { rows: [{ id: randomUUID() }] };
      return { rows: [] };
    },
    release,
  };
  return {
    command,
    proof,
    queries,
    client,
    release,
    pool: { connect: async () => client },
  };
}
describe('coupon evidence lifecycle and transaction ownership', () => {
  it('awaits local SQL revalidation beyond the external deadline before commit/release', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let finish: (value: ConsumptionEvidence) => void = () => {};
      const revalidate = vi.fn(
        () =>
          new Promise<ConsumptionEvidence>((resolve) => {
            finish = resolve;
          }),
      );
      const evidence: CouponEvidenceProvider = {
        verify: async () => f.proof,
        revalidate,
      };
      const result = new CouponCommandProcessor(f.pool, evidence).process(
        f.command,
        'modulo-ventas',
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(revalidate).toHaveBeenCalledWith(
        expect.anything(),
        f.proof,
        f.client,
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(f.release).not.toHaveBeenCalled();
      expect(f.queries).not.toContain('COMMIT');
      expect(f.queries).not.toContain('ROLLBACK');
      finish(f.proof);
      expect((await result).name).toMatch(/consumption.completed$/);
      expect(f.queries.at(-1)).toBe('COMMIT');
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('aborts late external evidence without starting SQL revalidation or a durable rejection', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let finish: (value: ConsumptionEvidence) => void = () => {};
      let externalSignal: AbortSignal | undefined;
      const revalidate = vi.fn(async () => f.proof);
      const result = new CouponCommandProcessor(f.pool, {
        verify: async (_command, signal) => {
          externalSignal = signal;
          return new Promise<ConsumptionEvidence>((resolve) => {
            finish = resolve;
          });
        },
        revalidate,
      }).process(f.command, 'modulo-ventas');
      const rejected = expect(result).rejects.toThrow(
        'COUPON_EVIDENCE_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(1001);
      await rejected;
      expect(externalSignal?.aborted).toBe(true);
      expect(f.queries.at(-1)).toBe('ROLLBACK');
      finish(f.proof);
      await vi.advanceTimersByTimeAsync(0);
      expect(revalidate).not.toHaveBeenCalled();
      expect(
        f.queries.some((q) => q.includes('INSERT INTO promotions.outbox')),
      ).toBe(false);
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('rolls back technical revalidation failure instead of committing a business rejection', async () => {
    const f = fixture();
    const evidence: CouponEvidenceProvider = {
      verify: async () => f.proof,
      revalidate: async () => {
        throw new Error('private driver diagnostic');
      },
    };
    await expect(
      new CouponCommandProcessor(f.pool, evidence).process(
        f.command,
        'modulo-ventas',
      ),
    ).rejects.toThrow('COUPON_EVIDENCE_UNAVAILABLE');
    expect(f.queries.at(-1)).toBe('ROLLBACK');
    expect(
      f.queries.some((q) => q.includes('INSERT INTO promotions.outbox')),
    ).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });
});
