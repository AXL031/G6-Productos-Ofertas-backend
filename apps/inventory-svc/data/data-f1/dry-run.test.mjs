import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCandidate, prepareData, run, TABLES } from './dry-run.mjs';

const read = (file) =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const inputs = () => ({
  proposal: read('proposal.json'),
  catalog: read('catalog-reference.json'),
  baseline: read('baseline-empty.json'),
});
const tables = (candidate) =>
  Object.fromEntries(
    Object.keys(TABLES).map((table) => [
      table,
      structuredClone(
        candidate.inserts.find((group) => group.table === table)?.rows ?? [],
      ),
    ]),
  );
function loaded(candidate) {
  return {
    version: 1,
    schema: 'inventory',
    source: { kind: 'READ_ONLY_EXPORT', captured_at: '2026-10-17T01:00:00Z' },
    tables: tables(candidate),
  };
}

test('el dry-run entrega nueve saldos de siete SKU reales de la referencia, con trazabilidad y bloqueos explícitos', () => {
  const { proposal, catalog, baseline } = inputs();
  const before = structuredClone({ proposal, catalog, baseline });
  const report = prepareData(proposal, catalog, baseline);
  assert.equal(report.ready_for_load, false);
  assert.equal(report.baseline_kind, 'SYNTHETIC_EMPTY');
  assert.equal(report.status, 'PARTIAL');
  assert.equal(report.summary.skus, 7);
  assert.equal(report.summary.balances, 9);
  assert.equal(report.summary.opening_movements, 7);
  assert.equal(report.summary.insert, 38);
  assert.equal(report.unpublished_skus.length, 7);
  assert.ok(report.blockers.includes('NO_REAL_BASELINE'));
  assert.deepEqual({ proposal, catalog, baseline }, before);
  const rows = tables(report.candidate);
  assert.equal(rows.locations.length, 2);
  assert.equal(rows.inventory_operations.length, 9);
  assert.equal(rows.outbox.length, 9);
  assert.equal(rows.kardex.length, 7);
  for (const balance of rows.stock_balance) {
    assert.equal(balance.reserved, 0);
    assert.equal(balance.blocked, 0);
    assert.ok(!Object.hasOwn(balance, 'available'));
    assert.equal(balance.stock_version, balance.on_hand ? '1' : '0');
    const op = rows.inventory_operations.find(
      (row) =>
        row.sku_id === balance.sku_id &&
        row.location_id === balance.location_id,
    );
    assert.equal(op.client_id, null);
    assert.ok(!Object.hasOwn(op, 'accepted_at'));
    const event = rows.outbox.find(
      (row) => row.payload.operation_id === op.operation_id,
    );
    assert.equal(event.payload.name, 'inventory.stock.changed');
    assert.equal(event.event_id, event.payload.message_id);
    assert.equal(event.payload.data.available, balance.on_hand);
    const movements = rows.kardex.filter(
      (row) => row.operation_id === op.operation_id,
    );
    assert.equal(movements.length, balance.on_hand ? 1 : 0);
    if (movements.length) {
      assert.equal(movements[0].on_hand_before, 0);
      assert.equal(movements[0].on_hand_after, balance.on_hand);
    }
  }
});

test('mismo contenido produce las mismas identidades y hashes, incluso con arrays reordenados', () => {
  const { proposal, catalog, baseline } = inputs();
  const first = prepareData(proposal, catalog, baseline);
  proposal.locations.reverse();
  proposal.thresholds.reverse();
  proposal.balances.reverse();
  catalog.rows.reverse();
  const second = prepareData(proposal, catalog, baseline);
  assert.equal(first.candidate_sha256, second.candidate_sha256);
  assert.deepEqual(first.candidate, second.candidate);
});

test('replay completo es UNCHANGED; acepta outbox ya publicado sin proponer volverlo a PENDING', () => {
  const { proposal, catalog } = inputs();
  const candidate = buildCandidate(proposal, catalog);
  const baseline = loaded(candidate);
  baseline.tables.outbox.forEach((row) => {
    row.status = 'PUBLISHED';
    row.published_at = '2026-10-17T01:00:00Z';
  });
  const report = prepareData(proposal, catalog, baseline);
  assert.deepEqual(
    [report.summary.insert, report.summary.unchanged, report.summary.conflict],
    [0, 38, 0],
  );
});

test('saldo existente con versión o cantidad distinta genera conflicto, nunca UPDATE/DELETE', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  baseline.tables.stock_balance[0].on_hand++;
  baseline.tables.stock_balance[0].stock_version = '2';
  const report = prepareData(proposal, catalog, baseline);
  assert.equal(report.status, 'CONFLICT');
  assert.equal(report.summary.conflict, 1);
  assert.deepEqual(
    report.diff.find((row) => row.action === 'CONFLICT').columns.sort(),
    ['on_hand', 'stock_version'],
  );
  assert.ok(
    report.diff.every((row) =>
      ['INSERT', 'UNCHANGED', 'CONFLICT'].includes(row.action),
    ),
  );
});

test('no fabrica un Kardex de apertura cuando encuentra un saldo sin evidencia de apertura', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  baseline.tables.kardex = [];
  baseline.tables.outbox = [];
  const report = prepareData(proposal, catalog, baseline);
  assert.equal(report.status, 'CONFLICT');
  assert.equal(report.summary.insert, 0);
  assert.ok(
    report.diff.some((row) => row.reason === 'INCOMPLETE_OPENING_EVIDENCE'),
  );
});

test('IDs UUID equivalentes y bigint decimal no se confunden con drift', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  for (const [table, rows] of Object.entries(baseline.tables))
    for (const row of rows) {
      if (row.id) row.id = row.id.toUpperCase();
      if (row.location_id) row.location_id = row.location_id.toUpperCase();
      if (Object.hasOwn(row, 'stock_version'))
        row.stock_version = Number(row.stock_version);
      if (table === 'stock_balance')
        row.available = row.on_hand - row.reserved - row.blocked;
    }
  assert.equal(prepareData(proposal, catalog, baseline).summary.conflict, 0);
});

test('timestamptz equivalente con offset o precisión distinta no genera conflicto; un microsegundo distinto sí', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  baseline.tables.inventory_operations[0].applied_at =
    '2026-10-16T19:00:00.000000-05:00';
  assert.equal(prepareData(proposal, catalog, baseline).summary.conflict, 0);
  baseline.tables.inventory_operations[0].applied_at =
    '2026-10-16T19:00:00.000001-05:00';
  assert.equal(prepareData(proposal, catalog, baseline).summary.conflict, 1);
});

test('detecta colisión por código de ubicación aunque el PK sea diferente', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  const original = baseline.tables.locations[0].id;
  const replacement = '11111111-1111-5111-8111-111111111111';
  baseline.tables.locations[0].id = replacement;
  for (const rows of Object.values(baseline.tables))
    for (const row of rows)
      if (row.location_id === original) row.location_id = replacement;
  const report = prepareData(proposal, catalog, baseline);
  assert.ok(
    report.diff.some(
      (row) =>
        row.table === 'locations' && row.reason === 'ALTERNATE_KEY_COLLISION',
    ),
  );
});

test('un export con datos ajenos a la propuesta los conserva y no fabrica borrados', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  baseline.tables.locations.push({
    id: '11111111-1111-5111-8111-111111111111',
    code: 'OTRA-UBICACION',
    name: 'Otra',
    type: 'TIENDA',
    active: false,
  });
  const before = structuredClone(baseline);
  const report = prepareData(proposal, catalog, baseline);
  assert.equal(report.summary.conflict, 0);
  assert.equal(report.summary.unchanged, 38);
  assert.deepEqual(baseline, before);
});

for (const [name, modify, code] of [
  [
    'SKU ajeno',
    (p) => {
      p.balances[0].sku_id = 'NO-EXISTE';
    },
    'SKU_NOT_SELLABLE_REFERENCE',
  ],
  [
    'SKU base de padre',
    (p) => {
      p.balances[0].sku_id = 'ADI-ENT22-BASE';
    },
    'SKU_NOT_SELLABLE_REFERENCE',
  ],
  [
    'saldo negativo',
    (p) => {
      p.balances[0].on_hand = -1;
    },
    'INVALID_OPENING_BALANCE',
  ],
  [
    'overflow PostgreSQL integer',
    (p) => {
      p.balances[0].on_hand = 2147483648;
    },
    'INVALID_OPENING_BALANCE',
  ],
  [
    'reservas inventadas',
    (p) => {
      p.balances[0].reserved = 1;
    },
    'INVALID_OPENING_BALANCE',
  ],
  [
    'ubicación inactiva',
    (p) => {
      p.locations[0].active = false;
    },
    'OPENING_LOCATION_NOT_ACTIVE',
  ],
  [
    'ubicación no referenciada',
    (p) => {
      p.balances[0].location_id = '11111111-1111-5111-8111-111111111111';
    },
    'OPENING_LOCATION_NOT_ACTIVE',
  ],
  [
    'código duplicado',
    (p) => {
      p.locations[1].code = p.locations[0].code;
    },
    'DUPLICATE_LOCATION_CODE',
  ],
  [
    'saldo duplicado',
    (p) => {
      p.balances.push(structuredClone(p.balances[0]));
    },
    'DUPLICATE_ROW_KEY',
  ],
  [
    'umbral por ubicación',
    (p) => {
      p.thresholds[0].location_id = p.locations[0].id;
    },
    'INVALID_THRESHOLD',
  ],
  [
    'global ausente',
    (p) => {
      p.thresholds.shift();
    },
    'GLOBAL_THRESHOLD_REQUIRED',
  ],
  [
    'timestamp inválido',
    (p) => {
      p.opening_at = 'no-es-fecha';
    },
    'INVALID_PROPOSAL',
  ],
  [
    'día inexistente',
    (p) => {
      p.opening_at = '2026-02-30T00:00:00Z';
    },
    'INVALID_PROPOSAL',
  ],
])
  test(`rechaza ${name} antes de elaborar una carga`, () => {
    const { proposal, catalog } = inputs();
    modify(proposal);
    assert.throws(() => buildCandidate(proposal, catalog), new RegExp(code));
  });

test('baseline incompleta no se sustituye silenciosamente por arrays vacíos', () => {
  const { proposal, catalog, baseline } = inputs();
  delete baseline.tables.stock_balance;
  assert.throws(
    () => prepareData(proposal, catalog, baseline),
    /INCOMPLETE_SNAPSHOT/,
  );
});

test('no acepta un snapshot no vacío etiquetado como vacío sintético', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  baseline.source.kind = 'SYNTHETIC_EMPTY';
  assert.throws(
    () => prepareData(proposal, catalog, baseline),
    /SYNTHETIC_EMPTY_NOT_EMPTY/,
  );
});

test('detecta available derivado incorrectamente y referencias internas huérfanas', () => {
  const { proposal, catalog } = inputs();
  const baseline = loaded(buildCandidate(proposal, catalog));
  baseline.tables.stock_balance[0].available = -1;
  assert.throws(
    () => prepareData(proposal, catalog, baseline),
    /INVALID_GENERATED_AVAILABLE/,
  );
  delete baseline.tables.stock_balance[0].available;
  baseline.tables.locations = [];
  assert.throws(
    () => prepareData(proposal, catalog, baseline),
    /ORPHAN_LOCATION/,
  );
});

test('CLI rechaza apply/SQL y argumentos desconocidos sin leer ni imprimir credenciales', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('dry-run.mjs', import.meta.url)), '--apply', 'true'],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PGPASSWORD: 'secreto-sintetico' },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_ARGUMENTS/);
  assert.doesNotMatch(result.stderr + result.stdout, /secreto-sintetico/);
});

test('un reporte no puede sobrescribir los archivos de entrada', () => {
  const baseline = fileURLToPath(
    new URL('baseline-empty.json', import.meta.url),
  );
  assert.throws(
    () => run(['--baseline', baseline, '--report', baseline]),
    /REPORT_WOULD_OVERWRITE_INPUT/,
  );
});
