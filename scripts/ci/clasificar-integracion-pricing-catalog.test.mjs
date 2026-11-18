import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const classifier = fileURLToPath(
  new URL('./clasificar-integracion-pricing-catalog.mjs', import.meta.url),
);

function classify(...files) {
  const result = spawnSync(process.execPath, [classifier, ...files], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `Clasificador salió con ${result.status}`);
  }

  return result.stdout.trim();
}

test('omite la integración solo si el único archivo es AGENTS.md', () => {
  assert.equal(classify('AGENTS.md'), 'aplica=false');
});

test('ejecuta la integración si cambia Pricing', () => {
  assert.equal(
    classify('apps/pricing-svc/src/pricing.service.ts'),
    'aplica=true',
  );
});

test('ejecuta la integración si cambia Catalog', () => {
  assert.equal(
    classify('apps/catalog-svc/src/catalog.service.ts'),
    'aplica=true',
  );
});

test('ejecuta la integración si AGENTS.md acompaña cambios de código', () => {
  assert.equal(
    classify('AGENTS.md', 'apps/pricing-svc/src/pricing.service.ts'),
    'aplica=true',
  );
});

test('falla cerrado cuando no recibe archivos cambiados', () => {
  assert.equal(classify(), 'aplica=true');
});
