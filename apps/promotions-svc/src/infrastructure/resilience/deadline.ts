export class PromotionsDependencyTimeout extends Error {
  constructor() {
    super('PROMOTIONS_DEPENDENCY_TIMEOUT');
  }
}

// A timeout never schedules a retry. Adapters must honor the cancellation signal.
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 30000
  )
    throw new RangeError('INVALID_DEPENDENCY_TIMEOUT');
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => work(controller.signal))
        .then((value) => {
          if (performance.now() - started >= milliseconds) {
            controller.abort();
            throw new PromotionsDependencyTimeout();
          }
          return value;
        }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PromotionsDependencyTimeout());
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
