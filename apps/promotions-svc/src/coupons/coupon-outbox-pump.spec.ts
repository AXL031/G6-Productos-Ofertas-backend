import { CouponOutboxPump } from './coupon-outbox-pump.js';

describe('continuous transactional Outbox recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('recovers technical failures and pending confirms without concurrent publications', async () => {
    vi.useFakeTimers();
    let concurrent = 0;
    let maximum = 0;
    const publishOne = vi.fn(
      async (): Promise<'pending' | 'published' | 'empty'> => {
        maximum = Math.max(maximum, ++concurrent);
        await Promise.resolve();
        concurrent--;
        if (publishOne.mock.calls.length === 1)
          throw new Error('synthetic-private-diagnostic');
        if (publishOne.mock.calls.length === 2) return 'pending';
        if (publishOne.mock.calls.length === 3) return 'published';
        return 'empty';
      },
    );
    const failed = vi.fn();
    const pump = new CouponOutboxPump({ publishOne }, failed);
    pump.start();
    await vi.advanceTimersByTimeAsync(501);
    expect(publishOne).toHaveBeenCalledTimes(4);
    expect(failed).toHaveBeenCalledWith();
    expect(maximum).toBe(1);
    await pump.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publishOne).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the transaction to finish before shutdown and never starts twice', async () => {
    let finish: ((value: 'published') => void) | undefined;
    const publishOne = vi.fn(
      () =>
        new Promise<'published'>((resolve) => {
          finish = resolve;
        }),
    );
    const pump = new CouponOutboxPump({ publishOne }, () => undefined);
    pump.start();
    expect(() => pump.start()).toThrow('ALREADY_STARTED');
    let stopped = false;
    const stopping = pump.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish?.('published');
    await stopping;
    expect(publishOne).toHaveBeenCalledOnce();
  });

  it('reports missing confirms once per pending streak and reports a later failure after recovery', async () => {
    vi.useFakeTimers();
    const publishOne = vi
      .fn(async (): Promise<'pending' | 'published' | 'empty'> => 'empty')
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('published')
      .mockRejectedValueOnce(new Error('private broker details'))
      .mockResolvedValueOnce('pending');
    const failed = vi.fn(() => {
      throw new Error('observer unavailable');
    });
    const pump = new CouponOutboxPump({ publishOne }, failed);
    pump.start();
    await vi.advanceTimersByTimeAsync(751);
    expect(publishOne).toHaveBeenCalledTimes(5);
    expect(failed.mock.calls).toEqual([[], []]);
    await vi.advanceTimersByTimeAsync(250);
    expect(publishOne).toHaveBeenCalledTimes(6);
    await pump.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
