import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { withHttpClientSignal } from './client-cancellation.js';

function lifecycle() {
  const request = new IncomingMessage(new Socket());
  const response = new ServerResponse(request);
  return { request: Object.assign(request, { res: response }), response };
}
describe('HTTP client lifetime', () => {
  afterEach(() => vi.restoreAllMocks());
  it('ignores a completed request body and a normally finished response', async () => {
    const { request, response } = lifecycle();
    await withHttpClientSignal(request, async (signal) => {
      request.emit('close');
      vi.spyOn(response, 'writableFinished', 'get').mockReturnValue(true);
      expect(response.writableFinished).toBe(true);
      response.emit('close');
      expect(signal.aborted).toBe(false);
    });
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });
  it.each(['aborted', 'response-close'])(
    'aborts on %s before response completion and removes both listeners',
    async (event) => {
      const { request, response } = lifecycle();
      await withHttpClientSignal(request, async (signal) => {
        if (event === 'aborted') request.emit('aborted');
        else response.emit('close');
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toMatchObject({
          name: 'AbortError',
          message: 'HTTP_CLIENT_DISCONNECTED',
        });
      });
      expect(request.listenerCount('aborted')).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
    },
  );
  it('does not start work for a client already disconnected', async () => {
    const { request, response } = lifecycle();
    response.destroy();
    const work = vi.fn(async () => undefined);
    await expect(withHttpClientSignal(request, work)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(work).not.toHaveBeenCalled();
    expect(response.listenerCount('close')).toBe(0);
  });
  it('removes listeners on failure without affecting concurrent requests', async () => {
    const first = lifecycle(),
      second = lifecycle();
    const failure = new Error('fixture-failure');
    await withHttpClientSignal(second.request, async (signal) => {
      await expect(
        withHttpClientSignal(first.request, async () => {
          first.response.emit('close');
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(signal.aborted).toBe(false);
    });
    for (const { request, response } of [first, second]) {
      expect(request.listenerCount('aborted')).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
    }
  });
});
