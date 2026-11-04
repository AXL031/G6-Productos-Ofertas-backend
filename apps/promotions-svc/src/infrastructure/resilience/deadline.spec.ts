import { PromotionsDependencyTimeout, withDeadline } from './deadline.js';

describe('Dependency deadlines', () => {
  afterEach(() => vi.useRealTimers());
  it('clears the deadline on success and on synchronous adapter failure', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(async () => 'ok', 10)).resolves.toBe('ok');
    await expect(
      withDeadline(() => {
        throw new Error('adapter');
      }, 10),
    ).rejects.toThrow('adapter');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels once without retry and handles a late adapter rejection', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let reject!: (reason: Error) => void;
    const work = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    });
    const result = withDeadline(work, 10);
    const rejected = expect(result).rejects.toBeInstanceOf(
      PromotionsDependencyTimeout,
    );
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    reject(new Error('late sensitive diagnostics'));
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, -1, 0.5, 30001, NaN, Infinity])(
    'rejects invalid limit %s before work',
    async (limit) => {
      const work = vi.fn();
      await expect(withDeadline(work, limit)).rejects.toThrow(
        'INVALID_DEPENDENCY_TIMEOUT',
      );
      expect(work).not.toHaveBeenCalled();
    },
  );
});
