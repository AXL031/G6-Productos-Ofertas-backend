import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const INVENTORY_BILATERAL_SHA =
  '56aa4322725060b529bf316872f891582d7d1b2e';
export const PRICING_HISTORICAL_SHA =
  '807189f7ca49d4af3b4ad367043260bc3050fb3d';

/** Export immutable, unmodified peer source into the owned disposable directory.
 * A shallow CI checkout need not contain the peer commit. Fetch into a separate
 * bare object store; never change the user's branch, checkout, or peer files. */
export function pinnedInventorySource(directory: string, sha: string): string {
  return pinnedPreparationSource(directory, 'inventory', sha);
}
export function pinnedPricingSource(directory: string): string {
  return pinnedPreparationSource(directory, 'pricing', PRICING_HISTORICAL_SHA);
}
function pinnedPreparationSource(
  directory: string,
  peer: 'inventory' | 'pricing',
  sha: string,
): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid pinned peer SHA');
  const source = join(directory, peer + '-source-' + sha.slice(0, 12));
  mkdirSync(source);
  const objectStore = join(source, 'objects.git');
  const run = (args: string[]) => {
    const result = spawnSync(
      'git',
      ['-c', 'credential.helper=', '-c', 'http.extraHeader=', ...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
    if (result.status !== 0)
      throw new Error('Pinned preparation source unavailable');
    return result.stdout.trim();
  };
  run(['init', '--bare', objectStore]);
  run([
    '--git-dir',
    objectStore,
    'fetch',
    '--depth=1',
    'https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend.git',
    sha,
  ]);
  if (run(['--git-dir', objectStore, 'rev-parse', 'FETCH_HEAD']) !== sha)
    throw new Error('Pinned preparation SHA mismatch');
  const archive = spawnSync(
    'git',
    [
      '--git-dir',
      objectStore,
      'archive',
      sha,
      'package.json',
      'tsconfig.json',
      'apps/' + peer + '-svc',
    ],
    { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (archive.status !== 0)
    throw new Error('Pinned preparation archive unavailable');
  const extracted = spawnSync('tar', ['-xf', '-', '-C', source], {
    input: archive.stdout,
    windowsHide: true,
    timeout: 30000,
  });
  if (extracted.status !== 0)
    throw new Error('Pinned preparation export failed');
  console.log('BLOCK_A_' + peer.toUpperCase() + '_SOURCE_SHA=' + sha);
  return source;
}
