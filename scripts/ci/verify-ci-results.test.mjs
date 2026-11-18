import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./verify-ci-results.mjs', import.meta.url));
const required = ['tipos', 'unitarias', 'combos_catalogo', 'azure_cd_h5', 'seguridad_dependencias'];
const allSuccessful = () => Object.fromEntries(required.map((job) => [job, { result: 'success' }]));
function run(results) {
  return spawnSync(process.execPath, [checker, JSON.stringify(results), ...required], { encoding: 'utf8' });
}

test('los agregadores aceptan solo los resultados exitosos requeridos', () => {
  assert.equal(run(allSuccessful()).status, 0);
});

for (const job of required) {
  for (const status of ['failure', 'cancelled', 'skipped']) {
    test(`los agregadores rechazan ${job} con estado ${status}`, () => {
      const results = allSuccessful();
      results[job] = { result: status };
      const result = run(results);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${job}: ${status}`));
    });
  }

  test(`los agregadores rechazan ${job} ausente`, () => {
    const results = allSuccessful();
    delete results[job];
    const result = run(results);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${job}: ausente`));
  });
}
