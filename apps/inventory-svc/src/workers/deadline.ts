/** Limita la espera; no convierte un timeout en confirmación ni cancela efectos ya enviados. */
export async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Tiempo de espera agotado'), {
                code: 'ETIMEDOUT',
              }),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
