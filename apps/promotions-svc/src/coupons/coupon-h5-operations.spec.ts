import { randomUUID } from 'node:crypto';
import type {
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from '@azure/service-bus';
import type {
  SqlPool,
  SqlClient,
} from '../infrastructure/persistence/sql-transaction.js';
import {
  prepareCouponH5Admission,
  CouponH5Operations,
  CouponH5Worker,
  couponH5Queue,
} from './coupon-h5-operations.js';
import {
  CouponH5Relay,
  CouponH5DeliveryHandler,
  type CouponH5Claim,
} from './coupon-h5-delivery.js';
import type { CouponResult } from './coupon-command.js';

const body = () => ({
  operation_id: randomUUID(),
  order_id: 'PED-H5',
  coupon_code: 'DEMO_10',
  channel_id: 'MARKETPLACE',
  effective_at: '2026-11-18T10:00:00Z',
  reservation_id: randomUUID(),
  commercial_snapshot_ref: 'PED-H5',
});
const request = () => {
  const b = body();
  return prepareCouponH5Admission(
    'CONSUMIR_CUPON',
    b,
    b.operation_id,
    'modulo-ventas',
    randomUUID(),
  );
};

// Explicit transaction-port double. This suite does not claim PostgreSQL proof.
function database() {
  const rows = new Map<string, Record<string, unknown>>();
  const deliveries = new Set<string>();
  const receipts = new Map<string, Record<string, unknown>>();
  let savedRows = structuredClone(rows),
    savedDeliveries = structuredClone(deliveries);
  const fail = { outbox: false };
  const calls: string[] = [];
  const client: SqlClient = {
    release: vi.fn(),
    query: async (sql, v = []) => {
      calls.push(sql);
      if (sql.startsWith('BEGIN')) {
        savedRows = structuredClone(rows);
        savedDeliveries = structuredClone(deliveries);
      }
      if (sql === 'ROLLBACK') {
        rows.clear();
        savedRows.forEach((r, k) => rows.set(k, r));
        deliveries.clear();
        savedDeliveries.forEach((k) => deliveries.add(k));
      }
      if (sql.startsWith('INSERT INTO promotions.h5_coupon_operations')) {
        const r = {
          operation_id: v[0],
          message_id: v[1],
          source_client_id: v[2],
          order_id: v[3],
          operation_type: v[4],
          request_fingerprint: v[5],
          command: JSON.parse(String(v[6])),
          status: 'ACCEPTED',
          accepted_at: new Date('2026-11-18T10:00:00Z'),
          updated_at: new Date('2026-11-18T10:00:00Z'),
          completed_at: null,
          result_payload: null,
        };
        rows.set(String(v[0]), r);
        return { rows: [r] };
      }
      if (sql.startsWith('INSERT INTO promotions.h5_coupon_outbox')) {
        if (fail.outbox) throw new Error('SQL fixture failure');
        deliveries.add(String(v[0]));
      }
      if (sql.startsWith('SELECT command FROM')) {
        const r = [...rows.values()].find((r) => r.message_id === v[0]);
        return { rows: r ? [{ command: r.command }] : [] };
      }
      if (sql.startsWith('SELECT * FROM promotions.coupon_command_receipts')) {
        const r = receipts.get(String(v[0]));
        return { rows: r ? [r] : [] };
      }
      if (sql.startsWith('SELECT * FROM promotions.h5_coupon_operations')) {
        const r = rows.get(String(v[0]));
        return {
          rows:
            r &&
            (!sql.includes('order_id=$2') ||
              (r.order_id === v[1] && r.source_client_id === v[2]))
              ? [r]
              : [],
        };
      }
      if (sql.startsWith('UPDATE promotions.h5_coupon_operations')) {
        const r = rows.get(String(v[0]))!;
        Object.assign(r, {
          status: v[1],
          result_payload: JSON.parse(String(v[2])),
          completed_at: v[3],
          updated_at: v[3],
        });
      }
      return { rows: [] };
    },
  };
  const pool: SqlPool = { connect: async () => client };
  return {
    rows,
    deliveries,
    receipts,
    fail,
    calls,
    operations: new CouponH5Operations(pool),
  };
}

describe('Candidate H5 coupon admission and durable query', () => {
  it('recovers a pre-cut H4 result without enqueuing another command', async () => {
    const f = database(),
      r = request();
    const result: CouponResult = {
      ...r.command,
      message_id: randomUUID(),
      producer: 'promotions-svc',
      kind: 'result',
      name: r.command.name.replace('.requested', '.completed'),
      data: {
        order_id: 'PED-H5',
        coupon_code: 'DEMO_10',
        reservation_id: r.command.data.reservation_id,
        commercial_snapshot_ref: 'PED-H5',
        decided_at: '2026-11-18T10:00:00Z',
      },
    };
    f.receipts.set(r.command.operation_id, {
      request_fingerprint: r.fingerprint,
      source_client_id: r.actor,
      intention: 'CONSUMIR',
      status: 'COMPLETED',
      result_payload: result,
    });
    const accepted = await f.operations.admit(r);
    expect(accepted.replay).toBe(true);
    expect(accepted.snapshot.status).toBe('COMPLETED');
    expect(f.deliveries.size).toBe(0);
    f.receipts.set(randomUUID(), {});
  });
  it('rejects a fingerprint conflict against an existing H4 receipt before admitting H5', async () => {
    const f = database(),
      r = request();
    f.receipts.set(r.command.operation_id, {
      request_fingerprint: 'other',
      source_client_id: r.actor,
      intention: 'CONSUMIR',
    });
    await expect(f.operations.admit(r)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(f.rows.size).toBe(0);
  });
  it('projects the restoration result without leaking the legacy cupon_id field', async () => {
    const f = database(),
      operation_id = randomUUID();
    const r = prepareCouponH5Admission(
      'RESTAURAR_CUPON',
      {
        operation_id,
        order_id: 'PED-H5',
        consumption_operation_id: randomUUID(),
        cancellation_reason: 'ANULACION',
        cancelled_at: '2026-11-18T10:01:00Z',
      },
      operation_id,
      'modulo-ventas',
      randomUUID(),
    );
    await f.operations.admit(r);
    const result: CouponResult = {
      ...r.command,
      message_id: randomUUID(),
      producer: 'promotions-svc',
      kind: 'result',
      name: r.command.name.replace('.requested', '.completed'),
      data: {
        order_id: 'PED-H5',
        consumption_operation_id: r.command.data.consumption_operation_id,
        cupon_id: randomUUID(),
        restored: true,
        outcome: 'RESTORED',
        completed_at: '2026-11-18T10:02:00Z',
      },
    };
    await new CouponH5Worker(f.operations, {
      process: async () => result,
    }).process(r.command);
    const snap = await f.operations.get(
      operation_id,
      'PED-H5',
      'modulo-ventas',
    );
    expect(snap?.status).toBe('COMPLETED');
    expect(snap?.result).not.toHaveProperty('cupon_id');
    expect(f.rows.get(operation_id)?.result_payload).toEqual(result);
  });
  it('commits operation and intent together, replays identical content with the original MessageId', async () => {
    const f = database(),
      r = request();
    const initial = await f.operations.admit(r);
    expect(initial.replay).toBe(false);
    expect(initial.snapshot.status).toBe('ACCEPTED');
    expect(f.calls.at(-1)).toBe('COMMIT');
    const replay = await f.operations.admit({
      ...r,
      command: { ...r.command, message_id: randomUUID() },
    });
    expect(replay).toEqual({ ...initial, replay: true });
    expect(f.deliveries.size).toBe(1);
    expect(f.rows.get(r.command.operation_id)?.message_id).toBe(
      r.command.message_id,
    );
  });
  it('rolls back admission if the Outbox insert fails', async () => {
    const f = database();
    f.fail.outbox = true;
    await expect(f.operations.admit(request())).rejects.toThrow(
      'SQL fixture failure',
    );
    expect(f.rows.size).toBe(0);
    expect(f.deliveries.size).toBe(0);
    expect(f.calls.at(-1)).toBe('ROLLBACK');
  });
  it('rejects operation reuse with different semantic content', async () => {
    const f = database(),
      r = request();
    await f.operations.admit(r);
    const changed = prepareCouponH5Admission(
      'CONSUMIR_CUPON',
      {
        ...r.command.data,
        operation_id: r.command.operation_id,
        coupon_code: 'OTHER',
      },
      r.command.operation_id,
      'modulo-ventas',
      randomUUID(),
    );
    await expect(f.operations.admit(changed)).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(f.deliveries.size).toBe(1);
  });
  it('returns the same absence for nonexistent, another order and another client', async () => {
    const f = database(),
      r = request();
    await f.operations.admit(r);
    expect(
      await f.operations.get(r.command.operation_id, 'PED-H5', 'modulo-ventas'),
    ).toBeDefined();
    for (const [id, order, actor] of [
      [randomUUID(), 'PED-H5', 'modulo-ventas'],
      [r.command.operation_id, 'OTHER', 'modulo-ventas'],
      [r.command.operation_id, 'PED-H5', 'modulo-postventa'],
    ])
      expect(await f.operations.get(id, order, actor)).toBeUndefined();
    expect(f.deliveries.size).toBe(1);
  });
  it('validates identity, payload and header without creating commands', () => {
    const b = body();
    expect(() =>
      prepareCouponH5Admission(
        'CONSUMIR_CUPON',
        b,
        b.operation_id,
        'modulo-postventa',
        randomUUID(),
      ),
    ).toThrow('SCOPE_INSUFICIENTE');
    expect(() =>
      prepareCouponH5Admission(
        'CONSUMIR_CUPON',
        b,
        randomUUID(),
        'modulo-ventas',
        randomUUID(),
      ),
    ).toThrow('IDEMPOTENCY_CONFLICT');
    expect(() =>
      prepareCouponH5Admission(
        'CONSUMIR_CUPON',
        { ...b, reservation_id: undefined },
        b.operation_id,
        'modulo-ventas',
        randomUUID(),
      ),
    ).toThrow('VALIDACION');
    expect(() =>
      prepareCouponH5Admission(
        'RESTAURAR_CUPON',
        {
          operation_id: b.operation_id,
          order_id: b.order_id,
          cancellation_reason: 'ANULACION',
          cancelled_at: b.effective_at,
        },
        b.operation_id,
        'modulo-ventas',
        randomUUID(),
      ),
    ).toThrow('VALIDACION');
  });

  it('requires the snapshot reference to be the exact opaque order identifier', () => {
    const b = body();
    expect(() =>
      prepareCouponH5Admission(
        'CONSUMIR_CUPON',
        { ...b, commercial_snapshot_ref: b.order_id.toLowerCase() },
        b.operation_id,
        'modulo-ventas',
        randomUUID(),
      ),
    ).toThrow('VALIDACION');
  });
  it('persists the final public snapshot after the existing processor commits', async () => {
    const f = database(),
      r = request();
    await f.operations.admit(r);
    const result: CouponResult = {
      ...r.command,
      producer: 'promotions-svc',
      kind: 'result',
      name: r.command.name.replace('.requested', '.completed'),
      message_id: randomUUID(),
      data: {
        order_id: r.command.data.order_id,
        coupon_code: r.command.data.coupon_code,
        reservation_id: r.command.data.reservation_id,
        commercial_snapshot_ref: r.command.data.commercial_snapshot_ref,
        decided_at: '2026-11-18T10:00:01Z',
      },
    };
    const process = vi.fn(async () => result);
    const worker = new CouponH5Worker(f.operations, { process });
    await worker.process(r.command);
    const snapshot = await f.operations.get(
      r.command.operation_id,
      'PED-H5',
      'modulo-ventas',
    );
    expect(snapshot?.status).toBe('COMPLETED');
    expect(snapshot?.result).toEqual(result.data);
    await expect(
      worker.process({ ...r.command, message_id: randomUUID() }),
    ).rejects.toThrow('INVALID_COUPON_H5_COMMAND');
    expect(process).toHaveBeenCalledOnce();
  });
});

function senderFixture(fits = true) {
  const batch = { tryAddMessage: vi.fn(() => fits) };
  const sender = {
    createMessageBatch: vi.fn(async () => batch),
    sendMessages: vi.fn(async () => undefined),
  };
  return {
    batch,
    sender: sender as unknown as Pick<
      ServiceBusSender,
      'createMessageBatch' | 'sendMessages'
    >,
    send: sender.sendMessages,
  };
}

describe('H5 relay and manual settlement', () => {
  it.each([true, false])(
    'keeps intent pending after ambiguous send; current result=%s',
    async (success) => {
      const r = request(),
        f = senderFixture();
      if (!success) f.send.mockRejectedValueOnce(new Error('AMBIGUOUS'));
      const claim: CouponH5Claim = {
        command: r.command,
        messageId: r.command.message_id,
        token: randomUUID(),
      };
      const finish = vi.fn(async () => true);
      const relay = new CouponH5Relay(
        { claim: async () => claim, finish },
        f.sender,
      );
      expect(await relay.publishOne()).toBe(success ? 'sent' : 'pending');
      expect(finish.mock.calls[0][1]).toBe(success ? 'sent' : 'pending');
      expect(f.batch.tryAddMessage.mock.calls[0][0]).toMatchObject({
        messageId: r.command.message_id,
      });
    },
  );
  it('does not mark oversized messages as sent or retry them blindly', async () => {
    const r = request(),
      f = senderFixture(false),
      finish = vi.fn(async () => true);
    const relay = new CouponH5Relay(
      {
        claim: async () => ({
          command: r.command,
          messageId: r.command.message_id,
          token: randomUUID(),
        }),
        finish,
      },
      f.sender,
    );
    expect(await relay.publishOne()).toBe('too-large');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('waits for result persistence before completing and does not abandon on settlement failure', async () => {
    const r = request();
    const settlement = {
      completeMessage: vi.fn(async () => {
        throw new Error('LOCK_LOST');
      }),
      abandonMessage: vi.fn(async () => undefined),
      deadLetterMessage: vi.fn(async () => undefined),
    };
    const process = vi.fn(async () => undefined);
    const handler = new CouponH5DeliveryHandler(
      couponH5Queue,
      { process },
      settlement,
    );
    const m = {
      body: Buffer.from(JSON.stringify(r.command)),
      messageId: r.command.message_id,
      subject: r.command.name,
      correlationId: r.command.correlation_id,
      contentType: 'application/json',
      applicationProperties: {
        producer: 'promotions-svc',
        admitted_client: 'modulo-ventas',
        schema_version: 2,
        route_version: 1,
      },
    } as unknown as ServiceBusReceivedMessage;
    await expect(handler.handle(m)).rejects.toThrow('LOCK_LOST');
    expect(process).toHaveBeenCalledOnce();
    expect(settlement.abandonMessage).not.toHaveBeenCalled();
    expect(settlement.deadLetterMessage).not.toHaveBeenCalled();
  });
});
