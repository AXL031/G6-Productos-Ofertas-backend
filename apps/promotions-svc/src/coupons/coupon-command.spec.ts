import { randomUUID } from 'node:crypto';
import {
  commandFingerprint,
  consumptionName,
  parseCouponCommand,
} from './coupon-command.js';
import { matchesSchema } from './schema-validator.js';
import { couponContracts } from './coupon-contract.generated.js';

const command = () => ({
  message_id: randomUUID(),
  schema_version: 2,
  operation_id: randomUUID(),
  occurred_at: '2026-10-16T10:00:00Z',
  correlation_id: 'trace-not-a-uuid',
  causation_id: 'order-event',
  producer: 'modulo-ventas',
  kind: 'command',
  name: consumptionName,
  data: {
    order_id: 'PED-OPAQUE-001',
    coupon_code: 'DEMO_10',
    channel_id: 'MARKETPLACE',
    reservation_id: randomUUID(),
    commercial_snapshot_ref: 'durable:snapshot:1',
    effective_at: '2026-10-16T10:00:00Z',
  },
});

describe('coupon command contract and semantic identity', () => {
  it.each([undefined, null, '00000000-0000-4000-8000-000000000001'])(
    'preserves rc.3 restoration compatibility with original reference %s while D-04 sender conformance is separate',
    (reference) => {
      const input = {
        ...command(),
        name: 'promotions.coupon.restoration.requested',
        data: {
          order_id: 'PED-D04',
          cancellation_reason: 'cancelled',
          cancelled_at: '2026-10-16T11:00:00Z',
          ...(reference === undefined
            ? {}
            : { consumption_operation_id: reference }),
        },
      };
      expect(parseCouponCommand(input, 'modulo-ventas')).toEqual(input);
    },
  );
  it('accepts the exact v2 contract, opaque order and transport identities', () => {
    const input = command();
    expect(parseCouponCommand(input, 'modulo-ventas')).toEqual(input);
  });

  it.each([
    (value: ReturnType<typeof command>) => {
      value.schema_version = 1;
    },
    (value: ReturnType<typeof command>) => {
      value.producer = 'other-client';
    },
    (value: ReturnType<typeof command>) => {
      value.operation_id = 'not-a-uuid';
    },
    (value: ReturnType<typeof command>) => {
      value.data.reservation_id = 'accepted-202';
    },
    (value: ReturnType<typeof command>) => {
      value.data.effective_at = '2026-02-30T00:00:00Z';
    },
    (value: ReturnType<typeof command>) => {
      value.data.channel_id = 'UNKNOWN';
    },
  ])('rejects malformed envelope/data before any persistence', (mutate) => {
    const input = command();
    mutate(input);
    expect(() => parseCouponCommand(input, 'modulo-ventas')).toThrow(
      'INVALID_COUPON_COMMAND',
    );
  });

  it('does not use producer or AMQP appId as proof of the authenticated actor', () => {
    expect(() => parseCouponCommand(command(), 'untrusted')).toThrow(
      'INVALID_COUPON_COMMAND',
    );
  });

  it('fingerprints semantic input independently from retry/trace metadata and object key order', () => {
    const input = parseCouponCommand(command(), 'modulo-ventas');
    const retry = {
      ...input,
      message_id: randomUUID(),
      correlation_id: 'new-trace',
      data: {
        ...Object.fromEntries(Object.entries(input.data).reverse()),
        ...input.data,
        coupon_code: ' demo_10 ',
        customer_ref: null,
        effective_at: '2026-10-16T05:00:00-05:00',
      },
    };
    expect(commandFingerprint(input, 'modulo-ventas')).toBe(
      commandFingerprint(retry, 'modulo-ventas'),
    );
    expect(
      commandFingerprint(
        { ...input, data: { ...input.data, order_id: 'PED-OTHER' } },
        'modulo-ventas',
      ),
    ).not.toBe(commandFingerprint(input, 'modulo-ventas'));
  });

  it('keeps optional original consumption reference optional and requires a rejection code', () => {
    const input = {
      ...command(),
      name: 'promotions.coupon.restoration.requested',
      data: {
        order_id: 'PED-1',
        cancellation_reason: 'cancelled',
        cancelled_at: '2026-10-16T11:00:00Z',
      },
    };
    expect(() => parseCouponCommand(input, 'modulo-ventas')).not.toThrow();
    const rejection = {
      ...input,
      producer: 'promotions-svc',
      kind: 'result',
      name: 'promotions.coupon.restoration.rejected',
      data: { order_id: 'PED-1', completed_at: '2026-10-16T11:00:00Z' },
    };
    expect(
      matchesSchema(rejection, couponContracts[rejection.name].schema),
    ).toBe(false);
    expect(
      matchesSchema(
        {
          ...rejection,
          data: { ...rejection.data, result_code: 'IDEMPOTENCY_CONFLICT' },
        },
        couponContracts[rejection.name].schema,
      ),
    ).toBe(true);
  });
});
