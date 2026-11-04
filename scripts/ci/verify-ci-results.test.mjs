import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./verify-ci-results.mjs', import.meta.url));
const required = ['tipos', 'unitarias', 'combos_catalogo'];

function run(results) {
  return spawnSync(process.execPath, [checker, JSON.stringify(results), ...required], {
    encoding: 'utf8',
  });
}

test('el agregador acepta solo cuando todas las verificaciones terminan correctamente', () => {
  const result = run({
    tipos: { result: 'success' },
    unitarias: { result: 'success' },
    combos_catalogo: { result: 'success' },
  });
  assert.equal(result.status, 0);
});

for (const job of ['unitarias', 'combos_catalogo']) {
  for (const status of ['failure', 'cancelled', 'skipped']) {
    test(`el agregador rechaza ${job} con estado ${status}`, () => {
      const results = {
        tipos: { result: 'success' },
        unitarias: { result: 'success' },
        combos_catalogo: { result: 'success' },
      };
      results[job] = { result: status };
      const result = run(results);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${job}: ${status}`));
    });
  }

  test(`el agregador rechaza ${job} ausente`, () => {
    const results = {
      tipos: { result: 'success' },
      unitarias: { result: 'success' },
      combos_catalogo: { result: 'success' },
    };
    delete results[job];
    const result = run(results);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${job}: ausente`));
  });
}
