import {
  blockedCommercialContext,
  CommercialDependencyError,
  CommercialInputError,
  type CommercialContext,
} from '../../domain/commercial-context.js';
import { BoundedCommercialContext } from './commercial-deadline.js';

const basket = {
  channel_id: 'MARKETPLACE',
  lines: [{ sku: 'A', quantity: 1 }],
};
describe('Bounded commercial integration boundary', () => {
  it('preserves a contractual input error through the deadline boundary', async () => {
    const source = {
      ...blockedCommercialContext,
      basket: async () => {
        throw new CommercialInputError();
      },
    };
    await expect(
      new BoundedCommercialContext(source).basket(basket, 'at'),
    ).rejects.toBeInstanceOf(CommercialInputError);
  });
  afterEach(() => vi.useRealTimers());
  it('preserves the explicit default gate and its unblock condition', async () => {
    const context = new BoundedCommercialContext(blockedCommercialContext);
    await expect(
      context.basket(basket, '2026-10-23T00:00:00Z'),
    ).rejects.toMatchObject({
      owner: 'Catálogo/Pricing + integración G6',
      operation: 'evaluarPromociones/validarCupon',
    });
  });
  it('forwards each input and cancellation signal once without substituting facts', async () => {
    const resolved = { lines: [] };
    const source: CommercialContext = {
      basket: vi.fn().mockResolvedValue(resolved),
      recommendationOrigin: vi.fn().mockResolvedValue({
        active: true,
        channelEligible: true,
        categoryId: 'C',
      }),
      recommendationProducts: vi.fn().mockResolvedValue(new Map()),
    };
    const context = new BoundedCommercialContext(source);
    expect(await context.basket(basket, 'at')).toBe(resolved);
    await context.recommendationOrigin('P', 'MARKETPLACE');
    await context.recommendationProducts(['P'], 'MARKETPLACE');
    expect(source.basket).toHaveBeenCalledExactlyOnceWith(
      basket,
      'at',
      expect.any(AbortSignal),
      undefined,
    );
    expect(source.recommendationOrigin).toHaveBeenCalledExactlyOnceWith(
      'P',
      'MARKETPLACE',
      expect.any(AbortSignal),
      undefined,
    );
    expect(source.recommendationProducts).toHaveBeenCalledExactlyOnceWith(
      ['P'],
      'MARKETPLACE',
      expect.any(AbortSignal),
      undefined,
    );
  });
  it('preserves the request instant, correlation and caller cancellation', async () => {
    const controller = new AbortController();
    const requestContext = {
      at: '2026-11-04T12:00:00Z',
      correlationId: '11111111-1111-4111-8111-111111111111',
    };
    let received: AbortSignal | undefined;
    const source = {
      ...blockedCommercialContext,
      recommendationProducts: vi.fn(
        async (_ids, _channel, signal?: AbortSignal) => {
          received = signal;
          return new Map();
        },
      ),
    };
    await new BoundedCommercialContext(source).recommendationProducts(
      ['P'],
      'MARKETPLACE',
      controller.signal,
      requestContext,
    );
    expect(source.recommendationProducts).toHaveBeenCalledWith(
      ['P'],
      'MARKETPLACE',
      expect.any(AbortSignal),
      requestContext,
    );
    controller.abort();
    expect(received?.aborted).toBe(true);
  });
  it('bounds a hanging adapter, aborts transport and ignores its late answer without retry', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    const source = {
      ...blockedCommercialContext,
      basket: vi.fn((_request, _at, s?: AbortSignal) => {
        signal = s;
        return new Promise<{ lines: [] }>((resolve) => {
          finish = () => resolve({ lines: [] });
        });
      }),
    };
    const result = new BoundedCommercialContext(source, 20).basket(
      basket,
      'at',
    );
    const rejected = expect(result).rejects.toBeInstanceOf(
      CommercialDependencyError,
    );
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal?.aborted).toBe(true);
    finish();
    await Promise.resolve();
    expect(source.basket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not expose a transport exception or replace an outage with empty recommendations', async () => {
    const source = {
      ...blockedCommercialContext,
      recommendationProducts: async () => {
        throw new Error('https://user:secret@host/customer');
      },
    };
    await expect(
      new BoundedCommercialContext(source).recommendationProducts(
        ['P'],
        'MARKETPLACE',
      ),
    ).rejects.toMatchObject({
      message: 'COMMERCIAL_CONTEXT_UNAVAILABLE',
      operation: 'obtenerRecomendaciones/productos',
    });
  });
});
