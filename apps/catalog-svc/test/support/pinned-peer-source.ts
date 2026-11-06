import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const INVENTORY_BILATERAL_SHA =
  '8adcb6e2937580d289b9d20a1c7437473428aa8b';
export const INVENTORY_NO_LOCATION_SHA =
  '167090af6d4ae93adbde54b6741dd994d91bf70b';

/** Export immutable, unmodified peer source into the owned disposable directory.
 * A shallow CI checkout need not contain the peer commit. Fetch into a separate
 * bare object store; never change the user's branch, checkout, or peer files. */
export function pinnedInventorySource(directory: string, sha: string): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid pinned peer SHA');
  const source = join(directory, 'inventory-source-' + sha.slice(0, 12));
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
      throw new Error('Pinned Inventory source unavailable');
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
    throw new Error('Pinned Inventory SHA mismatch');
  const archive = spawnSync(
    'git',
    [
      '--git-dir',
      objectStore,
      'archive',
      sha,
      'package.json',
      'tsconfig.json',
      'apps/inventory-svc',
    ],
    { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (archive.status !== 0)
    throw new Error('Pinned Inventory archive unavailable');
  const extracted = spawnSync('tar', ['-xf', '-', '-C', source], {
    input: archive.stdout,
    windowsHide: true,
    timeout: 30000,
  });
  if (extracted.status !== 0) throw new Error('Pinned Inventory export failed');
  console.log('BLOCK_A_INVENTORY_SOURCE_SHA=' + sha);
  return source;
}
