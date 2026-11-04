import { describe, expect, it, vi, afterEach } from 'vitest';
import { DeactivationRecoveryRunner } from './deactivation-integration.ports.js';
import type { DeactivationIntentService } from './deactivation-intent.service.js';

afterEach(() => vi.useRealTimers());

describe('DeactivationRecoveryRunner', () => {
  it('ejecuta periódicamente sin solapar y espera el trabajo al cerrar', async () => {
    vi.useFakeTimers();
    let terminar!: (valor: number) => void;
    const recuperarVencidas = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          terminar = resolve;
        }),
    );
    const runner = new DeactivationRecoveryRunner({
      recuperarVencidas,
    } as unknown as DeactivationIntentService);
    runner.iniciar();
    runner.iniciar();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recuperarVencidas).toHaveBeenCalledTimes(1);
    let cerrado = false;
    const cierre = runner.onModuleDestroy().then(() => {
      cerrado = true;
    });
    await Promise.resolve();
    expect(cerrado).toBe(false);
    terminar(1);
    await cierre;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(recuperarVencidas).toHaveBeenCalledTimes(1);
  });
  it('vuelve a ejecutar después de un fallo sin registrar secretos', async () => {
    vi.useFakeTimers();
    const recuperarVencidas = vi
      .fn()
      .mockRejectedValueOnce(new Error('secreto'))
      .mockResolvedValue(0);
    const runner = new DeactivationRecoveryRunner({
      recuperarVencidas,
    } as unknown as DeactivationIntentService);
    runner.iniciar();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(recuperarVencidas).toHaveBeenCalledTimes(2);
    await runner.onModuleDestroy();
  });
});
