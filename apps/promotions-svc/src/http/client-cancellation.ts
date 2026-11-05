import type { IncomingMessage, ServerResponse } from 'node:http';

type RequestLifecycle = Pick<IncomingMessage, 'aborted' | 'once' | 'off'> & {
  res?: ServerResponse;
};

// IncomingMessage.close also occurs after a fully received POST. Only an
// aborted request or an unfinished response closing denotes client disconnect.
export async function withHttpClientSignal<T>(
  request: RequestLifecycle,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const response = request.res;
  const abort = () =>
    controller.abort(
      new DOMException('HTTP_CLIENT_DISCONNECTED', 'AbortError'),
    );
  const onClose = () => {
    if (!response?.writableFinished) abort();
  };
  request.once('aborted', abort);
  response?.once('close', onClose);
  try {
    if (request.aborted || (response?.destroyed && !response.writableFinished))
      abort();
    controller.signal.throwIfAborted();
    return await work(controller.signal);
  } finally {
    request.off('aborted', abort);
    response?.off('close', onClose);
  }
}
