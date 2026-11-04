import { PromotionsSvcService } from '../promotions-svc.service.js';
import { PromotionsReadinessService } from './promotions-readiness.service.js';

describe('Promotions readiness', () => {
  afterEach(() => vi.useRealTimers());

  it('does not confuse live process with implemented dependencies', async () => {
    expect(new PromotionsSvcService().getHealth().status).toBe('ok');
    expect(await new PromotionsReadinessService({}).check()).toEqual({
      status: 'not_ready',
      service: 'promotions-svc',
      dependencies: { database: 'not_implemented', broker: 'not_implemented' },
    });
  });

  it('requires both own dependencies to pass on every check', async () => {
    const database = { check: vi.fn().mockResolvedValue(undefined) };
    const broker = { check: vi.fn().mockResolvedValue(undefined) };
    const service = new PromotionsReadinessService({ database, broker });
    expect((await service.check()).status).toBe('ready');
    database.check.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await service.check()).toMatchObject({
      status: 'not_ready',
      dependencies: { database: 'down', broker: 'up' },
    });
    expect((await service.check()).status).toBe('ready');
    expect(broker.check).toHaveBeenCalledTimes(3);
  });

  it('bounds a hanging probe and does not leak its errors', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const service = new PromotionsReadinessService({
      database: {
        check: (value) => {
          signal = value;
          return new Promise<void>(() => undefined);
        },
      },
      broker: {
        check: () => Promise.reject(new Error('amqp://user:secret@host')),
      },
    });
    const result = service.check();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({
      status: 'not_ready',
      dependencies: { database: 'down', broker: 'down' },
    });
    expect(signal?.aborted).toBe(true);
    expect(JSON.stringify(await result)).not.toContain('secret');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not probe a broker unused by the requested operating profile', async () => {
    const broker = { check: vi.fn().mockRejectedValue(new Error('unused')) };
    const service = new PromotionsReadinessService({
      database: { check: async () => undefined },
      broker,
    });
    expect(await service.check(false)).toMatchObject({
      status: 'ready',
      dependencies: { database: 'up', broker: 'disabled' },
    });
    expect(broker.check).not.toHaveBeenCalled();
    expect((await service.check()).status).toBe('not_ready');
  });
  it('coalesces concurrent checks, does not cache completed probes and refuses readiness during drain', async () => {
    let finish!: () => void;
    const database = {
      check: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const service = new PromotionsReadinessService({ database });
    const first = service.check(false);
    const second = service.check(false);
    await Promise.resolve();
    expect(database.check).toHaveBeenCalledTimes(1);
    service.beforeApplicationShutdown();
    finish();
    expect((await first).status).toBe('not_ready');
    expect(await second).toEqual(await first);
    expect((await service.check(false)).status).toBe('not_ready');
    expect(database.check).toHaveBeenCalledTimes(1);
  });
});
