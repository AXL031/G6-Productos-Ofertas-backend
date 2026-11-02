import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./verify-ci-results.mjs', import.meta.url));
const required = ['tipos', 'unitarias'];

function run(results) {
  return spawnSync(process.execPath, [checker, JSON.stringify(results), ...required], {
    encoding: 'utf8',
  });
}

test('el agregador acepta solo cuando todas las verificaciones terminan correctamente', () => {
  const result = run({ tipos: { result: 'success' }, unitarias: { result: 'success' } });
  assert.equal(result.status, 0);
});

for (const status of ['failure', 'cancelled', 'skipped']) {
  test(`el agregador rechaza el estado ${status}`, () => {
    const result = run({ tipos: { result: 'success' }, unitarias: { result: status } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`unitarias: ${status}`));
  });
}

test('el agregador rechaza un trabajo obligatorio ausente', () => {
  const result = run({ tipos: { result: 'success' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unitarias: ausente/);
});
