import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pgBin =
  process.env.DATA002_PG_BIN ?? 'C:/Program Files/PostgreSQL/16/bin';
const available =
  (existsSync(join(pgBin, 'initdb.exe')) &&
    existsSync(resolve(pgBin, '../share/postgres.bki'))) ||
  existsSync(join(pgBin, 'initdb')) ||
  spawnSync('docker', ['info'], { windowsHide: true, timeout: 5000 }).status ===
    0;
if (process.env.CI === 'true' && !available) {
  throw new Error('DATA-002 requiere PostgreSQL aislado o Docker en CI');
}
describe.skipIf(!available)('DATA-002 en PostgreSQL desechable', () => {
  it('valida correcciones, conflictos, reintento y migraciones sin Supabase', () => {
    const result = spawnSync(
      process.execPath,
      ['--test', 'apps/catalog-svc/data002/isolated.test.mjs'],
      { encoding: 'utf8', windowsHide: true, timeout: 180000 },
    );
    expect(result.stderr + result.stdout).not.toContain('not ok');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    process.stdout.write(result.stdout);
  }, 190000);
});
