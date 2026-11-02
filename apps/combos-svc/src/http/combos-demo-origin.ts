import { isIP } from 'node:net';

function normalizedIp(address: string): string | undefined {
  const normalized = address.toLowerCase().startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
  return isIP(normalized) === 0 ? undefined : normalized.toLowerCase();
}

export function isAllowedDemoGatewayIp(
  remoteAddress: string | undefined,
  allowedAddresses: readonly string[],
): boolean {
  const source = remoteAddress && normalizedIp(remoteAddress);
  return Boolean(
    source &&
    allowedAddresses.some((address) => normalizedIp(address) === source),
  );
}
