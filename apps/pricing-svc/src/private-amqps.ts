import { isIP } from 'node:net';

/** Optional per-transport override. The original URL hostname remains the TLS identity. */
export function connectPrivateAmqps<T>(
  connect: (url: string, options: Record<string, unknown>) => Promise<T>,
  url: string,
  options: Record<string, unknown> = {},
  address = process.env.G6_AMQP_CONNECT_IP,
): Promise<T> {
  if (address === undefined) return connect(url, options);
  const endpoint = new URL(url);
  const tlsName = endpoint.hostname;
  if (
    isIP(address) !== 4 ||
    endpoint.protocol !== 'amqps:' ||
    !tlsName ||
    isIP(tlsName) ||
    endpoint.hash
  ) {
    throw new Error('Configuración de transporte AMQPS privado inválida');
  }
  endpoint.hostname = address;
  return connect(endpoint.href, {
    ...options,
    servername: tlsName,
    rejectUnauthorized: true,
  });
}
