import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service.js';
import { ReservationExpirationService } from '../reservations/reservation-expiration.service.js';
import { InventoryWorkersService } from './inventory-workers.service.js';

describe('InventoryWorkersService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('continúa Outbox si falla expiración, evita solapamientos y se recupera en el siguiente ciclo', async () => {
    vi.useFakeTimers();
    vi.stubEnv('INVENTORY_WORKER_INTERVAL_MS', '1000');
    let release!: () => void;
    const expire = vi
      .fn()
      .mockRejectedValueOnce(new Error('DB interrumpida'))
      .mockResolvedValue({ fallidas: 0 });
    const dispatch = vi
      .fn()
      .mockImplementationOnce(() =>
        new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => ({
          dispatched: 0,
          failed: 0,
          skipped: true,
          reason: 'DATABASE_UNAVAILABLE',
        })),
      )
      .mockResolvedValue({ dispatched: 1, failed: 0, skipped: false });
    const workers = new InventoryWorkersService(
      {
        expirarReservasVencidas: expire,
      } as unknown as ReservationExpirationService,
      { dispatchPending: dispatch } as unknown as OutboxPublisherService,
    );
    workers.onModuleInit();
    await vi.advanceTimersByTimeAsync(3000);
    expect(expire).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(workers.getMetrics()).toMatchObject({
      cycles: 1,
      running: true,
      expirationFailures: 1,
    });
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(workers.getMetrics()).toMatchObject({
      cycles: 2,
      running: false,
      outboxFailures: 1,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    await workers.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('inicia la expiración y el despacho sin invocaciones manuales', async () => {
    vi.useFakeTimers();
    const expiration = {
      expirarReservasVencidas: vi.fn().mockResolvedValue({
        procesadas: 0,
        expiradas: 0,
        fallidas: 0,
      }),
    } as unknown as ReservationExpirationService;
    const outbox = {
      dispatchPending: vi
        .fn()
        .mockResolvedValue({ dispatched: 0, failed: 0, skipped: false }),
    } as unknown as OutboxPublisherService;
    const workers = new InventoryWorkersService(expiration, outbox);

    workers.onModuleInit();
    await vi.waitFor(() => {
      expect(expiration.expirarReservasVencidas).toHaveBeenCalledOnce();
      expect(outbox.dispatchPending).toHaveBeenCalledOnce();
    });

    await workers.onModuleDestroy();
  });
});
