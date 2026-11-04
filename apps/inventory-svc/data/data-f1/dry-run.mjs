import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATASET = 'inventory-data-f1-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIELDS = new Set([
  'id',
  'location_id',
  'operation_id',
  'correlation_id',
  'event_id',
  'message_id',
  'causation_id',
]);
export const TABLES = {
  locations: ['id'],
  stock_threshold_override: ['id'],
  stock_balance: ['sku_id', 'location_id'],
  inventory_operations: ['id'],
  kardex: ['id'],
  outbox: ['id'],
  commercial_fulfillment_routes: ['id'],
};
const fail = (code) => {
  throw new Error(code);
};
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  !value.includes('\0');
const integer = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 2147483647;
const uuid = (value) => typeof value === 'string' && UUID.test(value);
const instant = (value) => {
  if (
    typeof value !== 'string' ||
    !/^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  return new Date(value.slice(0, 10) + 'T00:00:00Z')
    .toISOString()
    .startsWith(value.slice(0, 10));
};
const big = (value) =>
  ((typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) &&
  BigInt(value) <= 9223372036854775807n;

function canonical(value, field = '') {
  if (UUID_FIELDS.has(field) && uuid(value)) return value.toLowerCase();
  if (field === 'stock_version' && big(value)) return String(BigInt(value));
  if (
    ['applied_at', 'created_at', 'updated_at', 'occurred_at'].includes(field) &&
    instant(value)
  ) {
    const microseconds = (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0');
    return new Date(value)
      .toISOString()
      .replace(/\.\d{3}Z$/, `.${microseconds}Z`);
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key], key)]),
    );
  return value;
}
const json = (value) => JSON.stringify(canonical(value));
export const digest = (value) =>
  createHash('sha256').update(json(value)).digest('hex');
const key = (table, row) =>
  json(TABLES[table].map((column) => canonical(row[column], column)));

// UUIDv5, namespace URL de RFC 4122: identidad estable por dataset y clave lógica.
function id(label) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(`https://g6.inka-athletics/inventory/${DATASET}/${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function unique(rows, columns, code, predicate = () => true) {
  const seen = new Set();
  for (const row of rows.filter(predicate)) {
    const value = json(columns.map((column) => canonical(row[column], column)));
    if (seen.has(value)) fail(code);
    seen.add(value);
  }
}

function validateTables(tables) {
  if (
    !object(tables) ||
    Object.keys(tables).some((name) => !Object.hasOwn(TABLES, name))
  )
    fail('INVALID_SNAPSHOT_TABLES');
  for (const [table, columns] of Object.entries(TABLES)) {
    if (!Array.isArray(tables[table])) fail('INCOMPLETE_SNAPSHOT');
    for (const row of tables[table]) {
      if (!object(row) || columns.some((column) => !text(row[column])))
        fail('INVALID_ROW_KEY');
      for (const column of UUID_FIELDS)
        if (
          Object.hasOwn(row, column) &&
          row[column] !== null &&
          !uuid(row[column])
        )
          fail('INVALID_UUID');
      if (table === 'stock_balance') {
        if (
          !uuid(row.location_id) ||
          !['on_hand', 'reserved', 'blocked'].every((field) =>
            integer(row[field]),
          ) ||
          row.reserved + row.blocked > row.on_hand ||
          !big(row.stock_version)
        )
          fail('INVALID_STOCK_BALANCE');
        if (
          Object.hasOwn(row, 'available') &&
          row.available !== row.on_hand - row.reserved - row.blocked
        )
          fail('INVALID_GENERATED_AVAILABLE');
      }
      if (
        table === 'locations' &&
        (!text(row.code) ||
          !text(row.name) ||
          !text(row.type) ||
          typeof row.active !== 'boolean')
      )
        fail('INVALID_LOCATION');
      if (
        table === 'stock_threshold_override' &&
        (row.location_id !== null ||
          (row.sku_id !== null && !text(row.sku_id)) ||
          !integer(row.umbral_efectivo))
      )
        fail('INVALID_THRESHOLD');
      if (table === 'inventory_operations' && !text(row.idempotency_key))
        fail('INVALID_OPERATION_IDENTITY');
      if (
        table === 'kardex' &&
        (!Number.isInteger(row.quantity) ||
          row.quantity === 0 ||
          Math.abs(row.quantity) > 2147483647)
      )
        fail('INVALID_KARDEX');
      if (
        table === 'outbox' &&
        (!uuid(row.event_id) ||
          !object(row.payload) ||
          !['PENDING', 'PUBLISHED'].includes(row.status))
      )
        fail('INVALID_OUTBOX');
    }
    unique(tables[table], columns, 'DUPLICATE_ROW_KEY');
  }
  unique(tables.locations, ['code'], 'DUPLICATE_LOCATION_CODE');
  unique(
    tables.stock_threshold_override,
    ['sku_id'],
    'DUPLICATE_THRESHOLD_SCOPE',
  );
  unique(
    tables.inventory_operations,
    ['operation_id'],
    'DUPLICATE_OPERATION_ID',
    (row) => row.operation_id != null,
  );
  unique(
    tables.inventory_operations,
    ['idempotency_key'],
    'DUPLICATE_IDEMPOTENCY_KEY',
  );
  unique(tables.outbox, ['event_id'], 'DUPLICATE_EVENT_ID');
  const locations = new Set(
    tables.locations.map((row) => row.id.toLowerCase()),
  );
  for (const rows of Object.values(tables))
    for (const row of rows) {
      if (
        row.location_id != null &&
        !locations.has(row.location_id.toLowerCase())
      )
        fail('ORPHAN_LOCATION');
    }
}

export function buildCandidate(proposal, catalog) {
  if (
    !object(proposal) ||
    proposal.version !== 1 ||
    proposal.schema !== 'inventory' ||
    proposal.scenario !== 'Inka Athletics' ||
    proposal.classification !== 'demo' ||
    proposal.synthetic !== true ||
    !instant(proposal.opening_at)
  )
    fail('INVALID_PROPOSAL');
  if (
    !object(catalog) ||
    catalog.version !== 1 ||
    !object(catalog.source) ||
    catalog.source.kind !== 'HISTORICAL_READ_ONLY_AUDIT' ||
    !instant(catalog.source.captured_at) ||
    !Array.isArray(catalog.rows)
  )
    fail('INVALID_CATALOG_REFERENCE');
  for (const row of catalog.rows)
    if (
      !object(row) ||
      !text(row.sku) ||
      !uuid(row.product_id) ||
      (row.variant_id !== null && !uuid(row.variant_id)) ||
      !['SIMPLE', 'VARIANTE', 'BASE_NO_VENDIBLE'].includes(row.kind) ||
      (row.kind === 'VARIANTE' && row.variant_id === null) ||
      (row.kind !== 'VARIANTE' && row.variant_id !== null)
    )
      fail('INVALID_CATALOG_IDENTITY');
  unique(catalog.rows, ['sku'], 'DUPLICATE_CATALOG_SKU');
  const skuMap = new Map(catalog.rows.map((row) => [row.sku, row]));
  for (const field of ['locations', 'thresholds', 'balances'])
    if (!Array.isArray(proposal[field]) || proposal[field].length === 0)
      fail('EMPTY_PROPOSAL');
  const requireSku = (sku) => {
    const ref = skuMap.get(sku);
    if (!ref || ref.kind === 'BASE_NO_VENDIBLE')
      fail('SKU_NOT_SELLABLE_REFERENCE');
    return ref;
  };
  const tables = Object.fromEntries(
    Object.keys(TABLES).map((name) => [name, []]),
  );
  tables.locations = proposal.locations.map((row) => {
    if (
      !object(row) ||
      Object.keys(row).some(
        (name) =>
          !['id', 'code', 'name', 'type', 'external_ref', 'active'].includes(
            name,
          ),
      ) ||
      (row.external_ref !== null && !text(row.external_ref))
    )
      fail('INVALID_LOCATION');
    return { ...row, id: uuid(row.id) ? row.id.toLowerCase() : row.id };
  });
  for (const row of proposal.thresholds) {
    if (
      !object(row) ||
      Object.keys(row).some(
        (name) => !['sku_id', 'umbral_efectivo'].includes(name),
      ) ||
      (row.sku_id !== null && !text(row.sku_id)) ||
      !integer(row.umbral_efectivo)
    )
      fail('INVALID_THRESHOLD');
    if (row.sku_id !== null) requireSku(row.sku_id);
    tables.stock_threshold_override.push({
      id: id(`threshold:${row.sku_id ?? 'global'}`),
      sku_id: row.sku_id,
      location_id: null,
      umbral_efectivo: row.umbral_efectivo,
    });
  }
  if (proposal.thresholds.filter((row) => row.sku_id === null).length !== 1)
    fail('GLOBAL_THRESHOLD_REQUIRED');
  const global = proposal.thresholds.find(
    (row) => row.sku_id === null,
  ).umbral_efectivo;
  const active = new Set(
    tables.locations.filter((row) => row.active).map((row) => row.id),
  );
  for (const row of proposal.balances) {
    if (
      !object(row) ||
      Object.keys(row).some(
        (name) =>
          !['sku_id', 'location_id', 'on_hand', 'reason'].includes(name),
      ) ||
      !text(row.sku_id) ||
      !uuid(row.location_id) ||
      !integer(row.on_hand) ||
      !text(row.reason)
    )
      fail('INVALID_OPENING_BALANCE');
    requireSku(row.sku_id);
    const location = row.location_id.toLowerCase();
    if (!active.has(location)) fail('OPENING_LOCATION_NOT_ACTIVE');
    const label = `${row.sku_id}:${location}`;
    const operation = id(`operation:${label}`);
    const version = row.on_hand > 0 ? '1' : '0';
    const balance = {
      sku_id: row.sku_id,
      location_id: location,
      on_hand: row.on_hand,
      reserved: 0,
      blocked: 0,
      stock_version: version,
    };
    tables.stock_balance.push(balance);
    const request = {
      dataset: DATASET,
      sku_id: row.sku_id,
      location_id: location,
      on_hand: row.on_hand,
    };
    tables.inventory_operations.push({
      id: id(`operation-row:${label}`),
      operation_id: operation,
      operation_type:
        row.on_hand > 0 ? 'AJUSTE_ABSOLUTO' : 'INICIALIZACION_SKU',
      idempotency_key: `${DATASET}:${label}`,
      intention: 'data-f1-opening',
      status: 'APLICADO',
      sku_id: row.sku_id,
      location_id: location,
      quantity_requested: row.on_hand,
      quantity_applied: row.on_hand,
      correlation_id: id('correlation'),
      client_id: null,
      request_fingerprint: digest(request),
      request_payload: request,
      result_payload: { ...balance, available: row.on_hand },
      stock_version: version,
      applied_at: proposal.opening_at,
    });
    if (row.on_hand > 0)
      tables.kardex.push({
        id: id(`kardex:${label}`),
        sku_id: row.sku_id,
        location_id: location,
        operation_type: 'AJUSTE_ABSOLUTO',
        operation_id: operation,
        quantity: row.on_hand,
        on_hand_before: 0,
        on_hand_after: row.on_hand,
        reserved_before: 0,
        reserved_after: 0,
        blocked_before: 0,
        blocked_after: 0,
        stock_version: version,
        correlation_id: id('correlation'),
      });
    const threshold =
      proposal.thresholds.find((entry) => entry.sku_id === row.sku_id)
        ?.umbral_efectivo ?? global;
    const messageId = id(`message:${label}`);
    tables.outbox.push({
      id: id(`outbox:${label}`),
      event_id: messageId,
      event_type: 'inventory.stock.changed',
      aggregate_type: 'stock',
      aggregate_id: row.sku_id,
      correlation_id: id('correlation'),
      status: 'PENDING',
      payload: {
        message_id: messageId,
        schema_version: 2,
        occurred_at: proposal.opening_at,
        correlation_id: id('correlation'),
        causation_id: operation,
        operation_id: operation,
        producer: 'inventory-svc',
        kind: 'event',
        name: 'inventory.stock.changed',
        data: {
          sku: row.sku_id,
          location_id: location,
          on_hand: row.on_hand,
          reserved: 0,
          blocked: 0,
          available: row.on_hand,
          estado:
            row.on_hand === 0
              ? 'AGOTADO'
              : row.on_hand <= threshold
                ? 'STOCK_BAJO'
                : 'DISPONIBLE',
          stock_version: Number(version),
          updated_at: proposal.opening_at,
        },
      },
    });
  }
  validateTables(tables);
  for (const [table, rows] of Object.entries(tables))
    rows.sort((a, b) => key(table, a).localeCompare(key(table, b), 'en'));
  return {
    version: 1,
    schema: 'inventory',
    kind: 'demo',
    description:
      'DATA-004: filas propuestas; NO cargadas ni autorizadas para aplicar',
    inserts: Object.entries(tables)
      .filter(([, rows]) => rows.length)
      .map(([table, rows]) => ({ table, rows })),
  };
}

export function prepareData(proposal, catalog, baseline) {
  const candidate = buildCandidate(proposal, catalog);
  if (
    !object(baseline) ||
    baseline.version !== 1 ||
    baseline.schema !== 'inventory' ||
    !object(baseline.source) ||
    !['SYNTHETIC_EMPTY', 'READ_ONLY_EXPORT'].includes(baseline.source.kind)
  )
    fail('INVALID_BASELINE');
  if (
    baseline.source.kind === 'READ_ONLY_EXPORT' &&
    !instant(baseline.source.captured_at)
  )
    fail('BASELINE_TIMESTAMP_REQUIRED');
  validateTables(baseline.tables);
  if (
    baseline.source.kind === 'SYNTHETIC_EMPTY' &&
    Object.values(baseline.tables).some((rows) => rows.length > 0)
  )
    fail('SYNTHETIC_EMPTY_NOT_EMPTY');
  const diff = [];
  const proposed = Object.fromEntries(
    Object.keys(TABLES).map((table) => [table, []]),
  );
  for (const group of candidate.inserts) proposed[group.table] = group.rows;
  for (const [table, rows] of Object.entries(proposed)) {
    const existing = new Map(
      baseline.tables[table].map((row) => [key(table, row), row]),
    );
    for (const row of rows) {
      const before = existing.get(key(table, row));
      const columns = Object.keys(row).filter(
        (field) => table !== 'outbox' || field !== 'status',
      );
      const changed = before
        ? columns.filter(
            (field) =>
              json({ [field]: before[field] }) !==
              json({ [field]: row[field] }),
          )
        : [];
      const aliases =
        table === 'locations'
          ? ['code']
          : table === 'inventory_operations'
            ? ['operation_id', 'idempotency_key']
            : table === 'outbox'
              ? ['event_id']
              : table === 'stock_threshold_override'
                ? ['sku_id']
                : [];
      const collision =
        !before &&
        baseline.tables[table].some((other) =>
          aliases.some(
            (field) =>
              json({ [field]: other[field] }) === json({ [field]: row[field] }),
          ),
        );
      diff.push({
        table,
        key: key(table, row),
        action:
          collision || changed.length
            ? 'CONFLICT'
            : before
              ? 'UNCHANGED'
              : 'INSERT',
        ...(collision
          ? { reason: 'ALTERNATE_KEY_COLLISION' }
          : changed.length
            ? { reason: 'CONTENT_CONFLICT', columns: changed }
            : {}),
      });
    }
  }
  // No inventar una apertura histórica cuando solo coincide el saldo, sin su evidencia atómica.
  for (const balance of proposed.stock_balance) {
    const operation = proposed.inventory_operations.find(
      (row) =>
        row.sku_id === balance.sku_id &&
        row.location_id === balance.location_id,
    );
    const entries = diff.filter((entry) => {
      const row = proposed[entry.table].find(
        (candidateRow) => key(entry.table, candidateRow) === entry.key,
      );
      return (
        (entry.table === 'stock_balance' &&
          entry.key === key('stock_balance', balance)) ||
        (['inventory_operations', 'kardex'].includes(entry.table) &&
          row?.operation_id === operation.operation_id) ||
        (entry.table === 'outbox' &&
          row?.payload.operation_id === operation.operation_id)
      );
    });
    if (
      entries.some((entry) => entry.action !== 'INSERT') &&
      entries.some((entry) => entry.action === 'INSERT')
    ) {
      for (const entry of entries)
        if (entry.action === 'INSERT') {
          entry.action = 'CONFLICT';
          entry.reason = 'INCOMPLETE_OPENING_EVIDENCE';
        }
    }
  }
  const counts = { insert: 0, unchanged: 0, conflict: 0 };
  for (const entry of diff) counts[entry.action.toLowerCase()]++;
  const used = [...new Set(proposal.balances.map((row) => row.sku_id))].sort();
  const unpublished = used.filter((sku) => {
    const ref = catalog.rows.find((row) => row.sku === sku);
    return (
      ref.product_status !== 'ACTIVO' ||
      (ref.kind === 'VARIANTE' && ref.variant_status !== 'ACTIVA')
    );
  });
  return {
    version: 1,
    mode: 'OFFLINE_DRY_RUN',
    dataset: DATASET,
    status: counts.conflict ? 'CONFLICT' : 'PARTIAL',
    ready_for_load: false,
    baseline_kind: baseline.source.kind,
    baseline_sha256: digest(baseline),
    candidate_sha256: digest(candidate),
    proposal_sha256: digest(proposal),
    catalog_reference_sha256: digest(catalog),
    summary: {
      skus: used.length,
      balances: proposed.stock_balance.length,
      opening_movements: proposed.kardex.length,
      ...counts,
    },
    blockers: [
      'CURRENT_CATALOG_CONFIRMATION_REQUIRED',
      'INVENTORY_SEED_REGISTRY_REVIEW_REQUIRED',
      'OUTBOX_SEED_GRANT_NOT_APPROVED',
      'MARCO_LOAD_AUTHORIZATION_REQUIRED',
      ...(baseline.source.kind === 'SYNTHETIC_EMPTY'
        ? ['NO_REAL_BASELINE']
        : []),
      ...(unpublished.length ? ['CATALOG_REFERENCE_NOT_PUBLISHED'] : []),
    ],
    unpublished_skus: unpublished,
    commercial_routes: 'NO_PROPOSED_MAPPING',
    diff,
    candidate,
  };
}

export function run(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--baseline', '--report'].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      Object.hasOwn(options, args[i])
    )
      fail('INVALID_ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  if (!options['--baseline']) fail('BASELINE_REQUIRED');
  if (
    options['--report'] &&
    [
      resolve(options['--baseline']),
      join(ROOT, 'proposal.json'),
      join(ROOT, 'catalog-reference.json'),
    ].some(
      (input) =>
        input.toLowerCase() === resolve(options['--report']).toLowerCase(),
    )
  )
    fail('REPORT_WOULD_OVERWRITE_INPUT');
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const report = prepareData(
    read(join(ROOT, 'proposal.json')),
    read(join(ROOT, 'catalog-reference.json')),
    read(resolve(options['--baseline'])),
  );
  if (options['--report'])
    writeFileSync(
      resolve(options['--report']),
      JSON.stringify(report, null, 2) + '\n',
    );
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = run(process.argv.slice(2));
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        mode: report.mode,
        ready_for_load: false,
        summary: report.summary,
        blockers: report.blockers,
        candidate_sha256: report.candidate_sha256,
      }) + '\n',
    );
    if (report.status === 'CONFLICT') process.exitCode = 2;
  } catch (error) {
    const known =
      error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)
        ? error.message
        : 'INPUT_OR_REPORT_ERROR';
    process.stderr.write(
      JSON.stringify({ status: 'FAIL', code: known }) + '\n',
    );
    process.exitCode = 1;
  }
}
