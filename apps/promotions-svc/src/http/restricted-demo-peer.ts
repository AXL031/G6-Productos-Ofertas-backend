import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { withDeadline } from '../infrastructure/resilience/deadline.js';

function normalized(address: string): string {
  return address.startsWith('::ffff:')
    ? address.slice(7)
    : address.toLowerCase();
}
function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  return isIP(address) === 6 && /^f[cd]/.test(address);
}

// Fixed alias from the Oracle Gateway network contract, never caller headers.
// Network membership/DNS ownership and the Gateway perimeter are release gates.
export async function restrictedDemoPeer(
  address: string | undefined,
): Promise<boolean> {
  if (!address) return false;
  const peer = normalized(address);
  if (peer === '127.0.0.1' || peer === '::1') return true;
  if (!privateAddress(peer)) return false;
  try {
    const addresses = await withDeadline(
      () => lookup('g6-api-gateway', { all: true }),
      500,
    );
    return (
      addresses.length > 0 &&
      addresses.every((entry) => privateAddress(normalized(entry.address))) &&
      addresses.some((entry) => normalized(entry.address) === peer)
    );
  } catch {
    return false;
  }
}
