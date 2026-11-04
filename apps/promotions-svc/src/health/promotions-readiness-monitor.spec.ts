import { createEnvironmentFixture } from '../../test/support/environment.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../infrastructure/config/promotions-config.js';
import { PromotionsOperationLogger } from '../infrastructure/logging/operation-logger.js';
import { PromotionsReadinessService } from './promotions-readiness.service.js';
import { PromotionsReadinessMonitor } from './promotions-readiness-monitor.js';

describe('Opt-in readiness monitoring', () => {
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());
  afterEach(() => vi.useRealTimers());
  function setup(enabled: boolean) {
    const settings = validatePromotionsConfiguration({
      ...fixture.environment,
      PROMOTIONS_DEPENDENCY_PROBES_ENABLED: String(enabled),
    });
    const database = { check: vi.fn().mockResolvedValue(undefined) };
    const broker = { check: vi.fn().mockResolvedValue(undefined) };
    const readiness = new PromotionsReadinessService({ database, broker });
    const write = vi.fn();
    const monitor = new PromotionsReadinessMonitor(
      new PromotionsConfigService(settings),
      readiness,
      new PromotionsOperationLogger(write),
    );
    return { database, broker, readiness, write, monitor };
  }
  it('has no probes, timers or logs by default', async () => {
    vi.useFakeTimers();
    const x = setup(false);
    await x.monitor.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15000);
    expect(x.database.check).not.toHaveBeenCalled();
    expect(x.broker.check).not.toHaveBeenCalled();
    expect(x.write).not.toHaveBeenCalled();
    await x.monitor.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('samples used dependencies, logs changes only and stops cleanly', async () => {
    vi.useFakeTimers();
    const x = setup(true);
    await x.monitor.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5000);
    expect(x.write).toHaveBeenCalledTimes(1);
    x.database.check.mockRejectedValueOnce(new Error('password=secret'));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(x.write).toHaveBeenCalledTimes(3);
    expect(x.broker.check).not.toHaveBeenCalled();
    expect(x.write.mock.calls.flat().join('')).not.toContain('secret');
    await x.monitor.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(15000);
    expect(x.database.check).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect((await x.readiness.check(false)).status).toBe('not_ready');
  });
  it('bounds shutdown during a hanging sample without overlapping probes or late logs', async () => {
    vi.useFakeTimers();
    const x = setup(true);
    x.database.check.mockImplementation(() => new Promise(() => undefined));
    const starting = x.monitor.onApplicationBootstrap();
    await Promise.resolve();
    const stopping = x.monitor.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([starting, stopping]);
    expect(x.database.check).toHaveBeenCalledTimes(1);
    expect(x.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
