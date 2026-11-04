import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CouponAmqpPublisher } from './coupon-amqp.js';
import type { CouponResult } from './coupon-command.js';

const result = (): CouponResult => ({
  message_id: randomUUID(),
  schema_version: 2,
  operation_id: randomUUID(),
  occurred_at: '2026-10-16T12:00:00Z',
  correlation_id: 'trace',
  causation_id: 'request',
  producer: 'promotions-svc',
  kind: 'result',
  name: 'promotions.coupon.restoration.completed',
  data: {
    order_id: 'PED-1',
    restored: false,
    outcome: 'NO_CONSUMPTION',
    completed_at: '2026-10-16T12:00:00Z',
  },
});
class TestChannel extends EventEmitter {
  mode: 'confirm' | 'return' | 'nack' | 'silent' = 'confirm';
  options: Record<string, unknown> = {};
  closed = false;
  publish(
    exchange: string,
    key: string,
    body: Buffer,
    options: Record<string, unknown>,
    callback: (error: unknown) => void,
  ) {
    expect(exchange).toBe('po.resultados.x');
    expect(key).toBe(result().name);
    expect(JSON.parse(body.toString()).kind).toBe('result');
    this.options = options;
    if (this.mode === 'return')
      this.emit('return', { properties: { messageId: options.messageId } });
    if (this.mode !== 'silent')
      callback(this.mode === 'nack' ? new Error('private-driver-error') : null);
    return false; // Backpressure is not a publisher confirm.
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
}

describe('coupon result publisher', () => {
  afterEach(() => vi.useRealTimers());
  it('publishes persistent/mandatory results and accepts only a broker confirm', async () => {
    const channel = new TestChannel();
    await expect(
      new CouponAmqpPublisher(channel).publishConfirmed(result()),
    ).resolves.toBeUndefined();
    expect(channel.options).toMatchObject({
      mandatory: true,
      persistent: true,
      contentType: 'application/json',
    });
    expect(channel.listenerCount('return')).toBe(0);
  });
  it.each(['return', 'nack'] as const)(
    'keeps %s failures unpublished and hides diagnostics',
    async (mode) => {
      const channel = new TestChannel();
      channel.mode = mode;
      await expect(
        new CouponAmqpPublisher(channel).publishConfirmed(result()),
      ).rejects.toThrow('PUBLISH_NOT_CONFIRMED');
    },
  );
  it('bounds a missing confirm and closes its dedicated channel', async () => {
    vi.useFakeTimers();
    const channel = new TestChannel();
    channel.mode = 'silent';
    const assertion = expect(
      new CouponAmqpPublisher(channel).publishConfirmed(result()),
    ).rejects.toThrow('PUBLISH_NOT_CONFIRMED');
    await vi.advanceTimersByTimeAsync(2001);
    await assertion;
    expect(channel.closed).toBe(true);
  });
});
