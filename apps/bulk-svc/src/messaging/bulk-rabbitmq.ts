export const BULK_AMQP_URL = Symbol('BULK_AMQP_URL');

export function configuredBulkAmqpUrl(env: NodeJS.ProcessEnv): string | null {
  if (
    env.BULK_AMQP_ENABLED !== undefined &&
    env.BULK_AMQP_ENABLED !== 'true' &&
    env.BULK_AMQP_ENABLED !== 'false'
  ) {
    throw new Error('BULK_AMQP_ENABLED debe ser true o false.');
  }
  if (env.BULK_AMQP_ENABLED !== 'true') return null;
  const raw = env.BULK_AMQP_URL;
  if (!raw) throw new Error('BULK_AMQP_URL es obligatorio al habilitar AMQP.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BULK_AMQP_URL debe ser una URL AMQP válida.');
  }
  if (
    !['amqp:', 'amqps:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === '/'
  ) {
    throw new Error('BULK_AMQP_URL debe incluir host y vhost.');
  }
  return raw;
}

export function bulkAmqpUserId(amqpUrl: string): string {
  let username: string;
  try {
    const url = new URL(amqpUrl);
    if (!['amqp:', 'amqps:'].includes(url.protocol))
      throw new Error('Protocolo AMQP inválido.');
    if (!url.username && !url.password) return 'guest';
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error('BULK_AMQP_URL debe incluir una identidad AMQP válida.');
  }
  if (!username) throw new Error('BULK_AMQP_URL debe incluir un usuario AMQP.');
  return username;
}
