import {
  READINESS_TIMEOUT_MS,
  ReadinessController,
  runReadinessCliProbe,
  UnconfiguredDatabase,
  withReadinessDeadline,
} from './readiness.js';

describe('readiness boundary', () => {
  afterEach(() => vi.useRealTimers());

  it('fails closed without a persistence adapter', async () => {
    await expect(
      new ReadinessController(new UnconfiguredDatabase()).ready(),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('requires a successful dependency check', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    await expect(new ReadinessController({ check }).ready()).resolves.toEqual({
      status: 'ready',
      service: 'catalog-svc',
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it('suppresses dependency errors and credentials', async () => {
    const controller = new ReadinessController({
      check: async () => {
        throw new Error('postgres://user:private-secret@host/db');
      },
    });
    try {
      await controller.ready();
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private-secret');
      expect(error).toMatchObject({ status: 503 });
    }
  });

  it('bounds a stalled dependency check', async () => {
    vi.useFakeTimers();
    const result = new ReadinessController({
      check: () => new Promise(() => {}),
    }).ready();
    const assertion = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses an explicit two-second functional deadline and handles late rejection', async () => {
    vi.useFakeTimers();
    expect(READINESS_TIMEOUT_MS).toBe(2000);
    let reject!: (error: Error) => void;
    const work = new Promise<void>((_resolve, rejectWork) => {
      reject = rejectWork;
    });
    const outcome = withReadinessDeadline(work);
    await vi.advanceTimersByTimeAsync(1999);
    await expect(
      Promise.race([outcome, Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('timed_out');
    reject(new Error('late dependency failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns ready with exit code zero from the CLI probe', async () => {
    const output: string[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const exitCode = await runReadinessCliProbe(
      async (progress) => {
        progress('database');
        progress('catalog-read');
      },
      close,
      { marketplaceDemoPreview: false, readDemo: { enabled: true } },
      (line) => output.push(line),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({
      service: 'catalog-svc',
      status: 'ready',
      database: 'ready',
      eligibility: 'not_evaluated_demo',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('marks CLI readiness not_ready on timeout and drains the operation before closing', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const output: string[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    let finished = false;
    const probe = runReadinessCliProbe(
      () => work,
      close,
      { marketplaceDemoPreview: false, readDemo: { enabled: true } },
      (line) => output.push(line),
    ).then((code) => {
      finished = true;
      return code;
    });

    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    expect(finished).toBe(false);
    expect(close).not.toHaveBeenCalled();
    finish();
    await expect(probe).resolves.toBe(1);
    expect(JSON.parse(output[0])).toMatchObject({
      service: 'catalog-svc',
      status: 'not_ready',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares concurrent checks and never reuses an earlier success', async () => {
    let finish!: () => void;
    const check = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new ReadinessController({ check });
    const probes = Array.from({ length: 100 }, () => controller.ready());
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();
    finish();
    await Promise.all(probes);
    check.mockRejectedValue(new Error('dependency down'));
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('stays closed after timeout without queuing more slow PostgreSQL checks', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const check = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new ReadinessController({ check });
    const probes = Array.from({ length: 100 }, () =>
      expect(controller.ready()).rejects.toMatchObject({ status: 503 }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(probes);
    for (let i = 0; i < 100; i++) {
      await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    }
    expect(check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    check.mockRejectedValue(new Error('still down'));
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    expect(check).toHaveBeenCalledTimes(2);
  });
});
