import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const loadSql = readFileSync(join(DIR, 'proposal-load.sql'), 'utf8');
const rollbackSql = readFileSync(join(DIR, 'proposal-rollback.sql'), 'utf8');

test('proposal-load.sql: no contiene psql meta-comandos y respeta ANSI/PostgreSQL transaccional', () => {
  assert.ok(!loadSql.includes('\\set'), 'No debe contener meta-comandos de psql como \\set');
  assert.ok(/\nBEGIN;\n/.test(loadSql), 'Debe contener bloque transaccional BEGIN;');
  assert.ok(loadSql.trim().endsWith('COMMIT;'), 'Debe finalizar con COMMIT;');
  assert.ok(!loadSql.includes('WARNING'), 'No debe degradar errores a WARNING; debe usar RAISE EXCEPTION');
  assert.ok(loadSql.includes('SET LOCAL search_path = inventory, public;'), 'Debe fijar search_path exclusivo');
  assert.ok(
    loadSql.includes("SELECT pg_advisory_xact_lock(hashtext('inventory.data-004.thresholds'));"),
    'Debe adquirir lock consultivo para concurrencia segura'
  );
});

test('proposal-load.sql: no contiene mutaciones destructivas sobre tablas existentes', () => {
  const forbiddenMutations = [
    /UPDATE\s+inventory\.stock_balance/i,
    /DELETE\s+FROM\s+inventory\.stock_balance/i,
    /TRUNCATE/i,
    /DROP\s+TABLE/i,
    /ALTER\s+TABLE/i,
    /UPDATE\s+inventory\.locations/i,
    /DELETE\s+FROM\s+inventory\.locations/i,
    /UPDATE\s+inventory\.kardex/i,
    /DELETE\s+FROM\s+inventory\.kardex/i,
    /UPDATE\s+inventory\.inventory_operations/i,
    /DELETE\s+FROM\s+inventory\.inventory_operations/i,
  ];

  for (const pattern of forbiddenMutations) {
    assert.ok(!pattern.test(loadSql), `No debe contener mutaciones prohibidas: ${pattern}`);
  }
});

test('proposal-load.sql: valida precondiciones y aborta con RAISE EXCEPTION', () => {
  assert.ok(loadSql.includes("RAISE EXCEPTION 'Destino inválido:"), 'Debe validar esquema inventory');
  assert.ok(loadSql.includes("RAISE EXCEPTION 'Precondición fallida: se esperaban exactamente 2 ubicaciones"), 'Debe validar las 2 ubicaciones');
  assert.ok(loadSql.includes("RAISE EXCEPTION 'Precondición fallida: se esperaban exactamente 14 saldos"), 'Debe validar los 14 saldos');
  assert.ok(loadSql.includes("RAISE EXCEPTION 'Precondición fallida: ya existe un umbral global incompatible"), 'Debe validar ausencia de umbral global conflictivo');
  assert.ok(loadSql.includes("RAISE EXCEPTION 'Precondición fallida: ya existe un umbral incompatible para ADI-ENT22-AZU-M"), 'Debe validar ausencia de umbral conflictivo de SKU');
});

test('proposal-load.sql: implementa idempotencia por clave de negocio funcional (WHERE NOT EXISTS)', () => {
  assert.ok(
    loadSql.includes('WHERE NOT EXISTS (\n  SELECT 1 FROM inventory.stock_threshold_override\n  WHERE sku_id IS NULL AND location_id IS NULL\n)'),
    'El umbral global debe protegerse por clave de negocio funcional'
  );
  assert.ok(
    loadSql.includes("WHERE NOT EXISTS (\n  SELECT 1 FROM inventory.stock_threshold_override\n  WHERE sku_id = 'ADI-ENT22-AZU-M' AND location_id IS NULL\n)"),
    'El umbral de SKU debe protegerse por clave de negocio funcional'
  );
});

test('proposal-rollback.sql: es selectivo, seguro y acotado exclusivamente a DATA-004', () => {
  assert.ok(!rollbackSql.includes('\\set'), 'No debe contener meta-comandos de psql');
  assert.ok(/\nBEGIN;\n/.test(rollbackSql), 'Debe contener bloque transaccional BEGIN;');
  assert.ok(rollbackSql.trim().endsWith('COMMIT;'), 'Debe finalizar con COMMIT;');
  assert.ok(rollbackSql.includes('DELETE FROM inventory.stock_threshold_override'), 'Debe eliminar solo de stock_threshold_override');
  assert.ok(
    rollbackSql.includes("SELECT pg_advisory_xact_lock(hashtext('inventory.data-004.thresholds'));"),
    'Debe adquirir lock consultivo para serialización segura'
  );
  assert.ok(
    rollbackSql.includes("id IN (\n  '0a24fa68-450f-5fa1-827d-78fb5f09fe54'::uuid,\n  '7b49463c-333e-5e63-b8ad-344c20847250'::uuid\n)"),
    'Debe filtrar estrictamente por los UUIDs atribuibles a DATA-004'
  );
  assert.ok(
    !rollbackSql.includes('OR (sku_id IS NULL AND location_id IS NULL'),
    'No debe incluir eliminación genérica por clave de negocio que borre registros ajenos'
  );
  assert.ok(rollbackSql.includes('v_balances <> 14'), 'Debe verificar que los 14 saldos permanezcan intactos');
  assert.ok(rollbackSql.includes('v_locations <> 2'), 'Debe verificar que las 2 ubicaciones permanezcan intactas');
});

test('simulación de ejecución atómica, idempotencia en segunda pasada, rollback y preservación de datos previos', () => {
  // Simulación de base con estado del baseline real de Supabase y un umbral preexistente
  const db = {
    locations: [
      { id: '9129b578-631e-1735-8427-b683fb524380', code: 'ALM-LURIN', active: true },
      { id: 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485', code: 'TDA-MIRAFLORES', active: true },
    ],
    stock_balance: Array.from({ length: 14 }, (_, i) => ({
      id: `bal-${i}`,
      location_id: i % 2 === 0 ? '9129b578-631e-1735-8427-b683fb524380' : 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485',
      sku_id: `SKU-${Math.floor(i / 2)}`,
      on_hand: 10,
    })),
    stock_threshold_override: [
      // Umbral preexistente ajeno a DATA-004
      {
        id: 'a0000000-0000-0000-0000-000000000001',
        sku_id: 'PRE-EXISTING-SKU',
        location_id: null,
        umbral_efectivo: 7,
      },
    ],
  };

  function executeLoad(state) {
    // 1. Precondiciones
    const activeLocations = state.locations.filter(
      l => ['9129b578-631e-1735-8427-b683fb524380', 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'].includes(l.id) && l.active
    ).length;
    if (activeLocations !== 2) throw new Error('PRECONDITION_LOCATIONS_FAILED');

    const balances = state.stock_balance.filter(
      b => ['9129b578-631e-1735-8427-b683fb524380', 'aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485'].includes(b.location_id)
    ).length;
    if (balances !== 14) throw new Error('PRECONDITION_BALANCES_FAILED');

    // Conflicting thresholds check
    const badGlobal = state.stock_threshold_override.filter(t => t.sku_id === null && t.location_id === null && t.umbral_efectivo !== 5).length;
    if (badGlobal > 0) throw new Error('PRECONDITION_CONFLICTING_GLOBAL');

    const badSku = state.stock_threshold_override.filter(t => t.sku_id === 'ADI-ENT22-AZU-M' && t.location_id === null && t.umbral_efectivo !== 3).length;
    if (badSku > 0) throw new Error('PRECONDITION_CONFLICTING_SKU');

    // 2. Inserciones protegidas por WHERE NOT EXISTS
    const hasGlobal = state.stock_threshold_override.some(t => t.sku_id === null && t.location_id === null);
    if (!hasGlobal) {
      state.stock_threshold_override.push({
        id: '0a24fa68-450f-5fa1-827d-78fb5f09fe54',
        sku_id: null,
        location_id: null,
        umbral_efectivo: 5,
      });
    }

    const hasSku = state.stock_threshold_override.some(t => t.sku_id === 'ADI-ENT22-AZU-M' && t.location_id === null);
    if (!hasSku) {
      state.stock_threshold_override.push({
        id: '7b49463c-333e-5e63-b8ad-344c20847250',
        sku_id: 'ADI-ENT22-AZU-M',
        location_id: null,
        umbral_efectivo: 3,
      });
    }

    // 3. Post-verificaciones
    const globalT = state.stock_threshold_override.find(t => t.sku_id === null && t.location_id === null);
    if (!globalT || globalT.umbral_efectivo !== 5) throw new Error('POST_VERIFICATION_GLOBAL_FAILED');

    const skuT = state.stock_threshold_override.find(t => t.sku_id === 'ADI-ENT22-AZU-M' && t.location_id === null);
    if (!skuT || skuT.umbral_efectivo !== 3) throw new Error('POST_VERIFICATION_SKU_FAILED');

    if (state.stock_balance.length !== 14) throw new Error('POST_VERIFICATION_BALANCES_ALTERED');
  }

  function executeRollback(state) {
    const data004Ids = new Set([
      '0a24fa68-450f-5fa1-827d-78fb5f09fe54',
      '7b49463c-333e-5e63-b8ad-344c20847250',
    ]);
    state.stock_threshold_override = state.stock_threshold_override.filter(
      t => !data004Ids.has(t.id)
    );
    if (state.stock_balance.length !== 14) throw new Error('ROLLBACK_BALANCES_ALTERED');
    if (state.locations.length !== 2) throw new Error('ROLLBACK_LOCATIONS_ALTERED');
  }

  // Baseline inicial: 1 umbral preexistente
  assert.equal(db.stock_threshold_override.length, 1, 'Debe haber 1 umbral previo');

  // Primera ejecución (Carga inicial)
  executeLoad(db);
  assert.equal(db.stock_threshold_override.length, 3, 'Debe contener 3 umbrales (1 previo + 2 de DATA-004)');
  assert.ok(db.stock_threshold_override.some(t => t.id === 'a0000000-0000-0000-0000-000000000001'), 'El previo debe preservarse');
  assert.equal(db.stock_balance.length, 14, 'Los saldos deben permanecer en 14');
  assert.equal(db.locations.length, 2, 'Las ubicaciones deben permanecer en 2');

  // Segunda ejecución (Replay / Idempotencia)
  executeLoad(db);
  assert.equal(db.stock_threshold_override.length, 3, 'Replay no debe duplicar umbrales');
  assert.equal(db.stock_balance.length, 14, 'Replay no debe modificar saldos');

  // Ejecución de Rollback
  executeRollback(db);
  assert.equal(db.stock_threshold_override.length, 1, 'Rollback debe retirar solo los umbrales de DATA-004');
  assert.equal(db.stock_threshold_override[0].id, 'a0000000-0000-0000-0000-000000000001', 'El umbral previo debe quedar intacto');
  assert.equal(db.stock_balance.length, 14, 'Rollback no debe tocar los saldos');
  assert.equal(db.locations.length, 2, 'Rollback no debe tocar las ubicaciones');

  // Replay de Rollback
  executeRollback(db);
  assert.equal(db.stock_threshold_override.length, 1, 'Replay de rollback es idempotente');
  assert.equal(db.stock_threshold_override[0].id, 'a0000000-0000-0000-0000-000000000001', 'El umbral previo sigue intacto tras replay');

  // Verificación de precondiciones fallidas
  assert.throws(() => {
    const brokenDb = structuredClone(db);
    brokenDb.stock_balance.pop(); // Solo 13 saldos
    executeLoad(brokenDb);
  }, /PRECONDITION_BALANCES_FAILED/, 'Debe abortar si los saldos no son exactamente 14');

  assert.throws(() => {
    const brokenDb = structuredClone(db);
    brokenDb.locations[0].active = false; // Ubicación inactiva
    executeLoad(brokenDb);
  }, /PRECONDITION_LOCATIONS_FAILED/, 'Debe abortar si una ubicación no está activa');

  assert.throws(() => {
    const brokenDb = structuredClone(db);
    brokenDb.stock_threshold_override.push({ sku_id: null, location_id: null, umbral_efectivo: 10 }); // Incompatible
    executeLoad(brokenDb);
  }, /PRECONDITION_CONFLICTING_GLOBAL/, 'Debe abortar si ya existe un umbral global con valor incompatible');
});
