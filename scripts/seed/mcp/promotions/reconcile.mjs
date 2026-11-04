import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBatch, resolvePrice } from './prepare-batch.mjs';
import { validateDraft } from './validate-draft.mjs';

const draftUrl = new URL('./inka-athletics-draft.json', import.meta.url);
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Read-only capture -> review documents. No credentials, connection or SQL executor.
// A local hash checks integrity; it cannot authenticate who supplied a snapshot.
export function reconcile(
  snapshot,
  draft = JSON.parse(readFileSync(draftUrl, 'utf8')),
) {
  validateDraft(draft);
  assert.ok(
    snapshot?.project === draft.project &&
      snapshot.transaction_read_only === 'on',
    'READ_ONLY_CAPTURE_REQUIRED',
  );
  for (const key of [
    'products',
    'skus',
    'prices',
    'inventory',
    'categories',
    'brands',
    'seed_privileges',
    'locking_functions',
  ])
    assert.ok(Array.isArray(snapshot[key]), 'CAPTURE_LISTS_REQUIRED');
  const snapshotHash = hash(snapshot);
  const source = {
    reference: `supabase:${snapshot.project}:readonly:${snapshot.captured_at}`,
    sha256: snapshotHash,
  };
  const byName = (name) => {
    const matches = snapshot.products.filter((p) => p.name === name);
    assert.ok(matches.length <= 1, 'AMBIGUOUS_CATALOG_CANDIDATE');
    return matches[0];
  };
  const running = ['Nike Revolution 7', 'adidas Runfalcon 3.0'];
  const training = ['adidas Entrada 22'];
  const socks = ['adidas RUNxCUSHIONED', 'Nike Everyday Plus Cushioned'];
  const names = [...running, ...training, ...socks, 'Nike Pitch'];
  const products = names.map(byName).filter(Boolean);
  const selectedIds = new Set(products.map((p) => p.product_id));
  const skus = [
    ...snapshot.skus
      .filter((s) => selectedIds.has(s.product_id))
      .map((s) => ({ ...s, active: s.state === 'ACTIVA' })),
    ...products
      .filter((p) => !p.has_variants)
      .map((p) => ({
        product_id: p.product_id,
        sku: p.sku_base,
        state: p.state,
        catalog_version: p.catalog_version,
        active: p.state === 'ACTIVO',
      })),
  ].map((s) => ({
    ...s,
    channels: [],
    channel_evidence: {},
  }));
  const inventoryFor = (sku) =>
    snapshot.inventory.find((i) => i.sku === sku) ?? {
      sku,
      registered_locations: 0,
      positive_available_location: false,
    };
  const campaignScopes = [running, training].map((selection, i) => ({
    promotion_id: draft.proposed_rows.promotions[i].id,
    skus: skus
      .filter(
        (s) =>
          selection.some((name) => byName(name)?.product_id === s.product_id) &&
          inventoryFor(s.sku).positive_available_location,
      )
      .map((s) => s.sku)
      .sort(),
  }));
  const bindings = {
    version: 1,
    issue: 15,
    purpose: 'REVIEW',
    executable: false,
    status: 'CANDIDATES_NOT_COMMERCIALLY_APPROVED',
    catalog: {
      source,
      products: products.map((p) => ({ ...p, active: p.state === 'ACTIVO' })),
      skus,
    },
    pricing: {
      source,
      prices: snapshot.prices.filter(
        (p) =>
          selectedIds.has(p.product_id) || skus.some((s) => s.sku === p.sku),
      ),
    },
    inventory: { source, records: skus.map((s) => inventoryFor(s.sku)) },
    review: { reviewer: null, evidence: null },
    campaign_scopes: campaignScopes,
    recommendations: [
      {
        origin_product_id: byName(running[0])?.product_id ?? null,
        candidate_product_ids: socks
          .map(byName)
          .filter(Boolean)
          .map((p) => p.product_id),
        status: 'PENDING_AVAILABILITY_AND_APPROVAL',
      },
      {
        origin_product_id: byName('Nike Pitch')?.product_id ?? null,
        candidate_product_ids: [],
        status: 'PENDING_CATALOG_CANDIDATE',
      },
    ],
  };
  const blockers = [];
  const block = (code, owner, operation, condition) =>
    blockers.push({ code, owner, operation, condition });
  for (const name of names.filter((n) => !byName(n)))
    block(
      'CATALOG_CANDIDATE_NOT_FOUND',
      'Poma',
      name,
      'Publicar y aprobar una referencia existente; no sustituirla automáticamente.',
    );
  const campaigns = draft.proposed_rows.promotions.map((campaign, index) => ({
    promotion_id: campaign.id,
    name: campaign.name,
    state: campaign.state,
    valid_from: campaign.valid_from,
    valid_until: campaign.valid_until,
    proposed_channels: campaign.enabled_channels,
    accredited_channels: [],
    references: skus
      .filter((s) =>
        [running, training][index].some(
          (name) => byName(name)?.product_id === s.product_id,
        ),
      )
      .map((s) => {
        const p = products.find((p) => p.product_id === s.product_id);
        let price = null,
          priceStatus = 'COVERED_GLOBAL_REFERENCE_ONLY';
        try {
          price = resolvePrice(
            bindings.pricing.prices,
            s.sku,
            s.product_id,
            null,
            campaign.valid_from,
            campaign.valid_until,
          );
        } catch (error) {
          if (!(error instanceof assert.AssertionError)) throw error;
          priceStatus = error.message;
          block(
            error.message,
            'Vera',
            `${campaign.name} / ${s.sku}`,
            'Publicar una vigencia monetaria única que cubra toda la campaña.',
          );
        }
        return {
          product_id: s.product_id,
          product_name: p.name,
          product_state: p.state,
          sku: s.sku,
          sku_state: s.state,
          proposed_scope: campaignScopes[index].skus.includes(s.sku),
          price_status: priceStatus,
          price_origin: price
            ? price.sku == null
              ? 'PRODUCTO'
              : 'SKU_OVERRIDE'
            : null,
          price,
          inventory: inventoryFor(s.sku),
          category:
            snapshot.categories.find((c) => c.id === p.category_id) ?? null,
          brand: snapshot.brands.find((b) => b.id === p.brand_id) ?? null,
        };
      }),
  }));
  if (products.some((p) => p.state !== 'ACTIVO') || skus.some((s) => !s.active))
    block(
      'PUBLISHED_ACTIVE_SKU_REQUIRED',
      'Poma',
      'Alcances y recomendaciones',
      'Aprobar y activar las referencias elegidas en Catálogo; recapturar estados/versiones.',
    );
  block(
    'COMMERCIAL_REVIEW_REQUIRED',
    'Poma + Vera + Axel',
    'Bindings del lote',
    'Revisar referencias, selección de SKU, descuentos y fuentes exactas; registrar aprobación comercial verificable.',
  );
  block(
    'CHANNEL_EVIDENCE_REQUIRED',
    'Poma + Vera',
    'Elegibilidad multicanal',
    'Acreditar canales permitidos de las referencias y resolución global/override; precio global no prueba elegibilidad de canal.',
  );
  const recommendations = bindings.recommendations.map((r, i) => ({
    ...r,
    name: draft.proposed_recommendations[i].name,
    candidates: r.candidate_product_ids.map((productId) => ({
      product_id: productId,
      state: products.find((p) => p.product_id === productId).state,
      prices: bindings.pricing.prices.filter((p) => p.product_id === productId),
      inventory_records: skus
        .filter((s) => s.product_id === productId)
        .map((s) => inventoryFor(s.sku)),
      availability: 'NOT_ACCREDITED',
    })),
  }));
  for (const r of recommendations) {
    if (!r.candidate_product_ids.length)
      block(
        'RECOMMENDATION_CANDIDATE_REQUIRED',
        'Poma',
        r.name,
        'Publicar y aprobar un accesorio de entrenamiento existente y compatible; no fabricar una referencia.',
      );
    if (
      r.candidates.some(
        (c) => !c.inventory_records.some((i) => i.positive_available_location),
      )
    )
      block(
        'RECOMMENDATION_AVAILABILITY_PENDING',
        'Taco + Poma',
        r.name,
        'Registrar stock real de candidatos aprobados y acreditar disponibilidad comercial; no sumar ubicaciones ni elegir SKU automáticamente (D-REC-01/02).',
      );
  }
  const lockTables = [
    'promotions.promotions',
    'promotions.recommendation_rules',
  ];
  const seedLockUnresolved = lockTables.some(
    (table) =>
      !snapshot.seed_privileges.some(
        (p) => p.table === table && p.insert && p.select && p.update_any_column,
      ),
  );
  if (seedLockUnresolved)
    block(
      'SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED',
      'Marco + revisión BD (Axel/López)',
      'INSERT de maestros hijos con po_promotions_seed',
      'Aprobar una solución de permisos/locking compatible con append-only y probarla con el rol restringido; no conceder UPDATE desde DATA-005.',
    );
  block(
    'BATCH_AND_TARGET_APPROVAL_REQUIRED',
    'Marco',
    'Carga persistente',
    'Aprobar contenido/hash, SQL, tablas, destino y postcheck tras resolver los bloqueos comerciales y de locking.',
  );
  let generatorStatus = 'STRUCTURALLY_PREPARED_ONLY';
  try {
    prepareBatch(bindings, draft);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    generatorStatus = error.message;
  }
  return {
    bindings,
    report: {
      version: 1,
      issue: 15,
      backend_base_sha: snapshot.backend_base_sha,
      state: 'IMPLEMENTADO_LOCAL / INTEGRACION_BLOQUEADA',
      executable: false,
      snapshot_sha256: snapshotHash,
      bindings_sha256: hash(bindings),
      captured_at: snapshot.captured_at,
      validation: {
        structural: 'READ_ONLY_CAPTURE_SHAPE_CHECKED',
        provenance:
          'OBSERVED_MCP_CAPTURE; LOCAL_HASH_IS_NOT_SOURCE_AUTHENTICATION',
        commercial_approval: 'PENDING',
        generator: generatorStatus,
        seed_role_authentication: 'NOT_TESTED_IN_SHARED_DATABASE',
        shared_writes: false,
        deployment: 'NOT_EXECUTED',
        homologation: 'NOT_ACCREDITED',
      },
      observed: {
        products: snapshot.products.length,
        variants: snapshot.skus.length,
        active_products: snapshot.products.filter((p) => p.state === 'ACTIVO')
          .length,
        prices: snapshot.prices.length,
        parent_prices: snapshot.prices.filter(
          (p) => p.product_id != null && p.sku == null,
        ).length,
        open_validities: snapshot.prices.filter((p) => p.valid_until === null)
          .length,
        promotions_counts: snapshot.promotions_counts,
      },
      campaigns,
      recommendations,
      seed_privileges: snapshot.seed_privileges,
      locking_functions: snapshot.locking_functions,
      blockers,
      schedule: {
        purpose: 'FUTURE_CAMPAIGN_PREPARATION',
        h4_date: '2026-10-31',
        dates_changed: false,
        active_h4_demo: 'PM_APPROVAL_REQUIRED_FOR_DIFFERENT_VALIDITY',
      },
      limitations: [
        'SQL/metadata reading is not authenticated HTTP integration, source-owner approval, seed-login authentication or deployment.',
        'Campaign price coverage is checked independently from channel accreditation and product activation.',
        'Inventory records and a positive location are observations, not a product-level availability promise or reservation.',
        'Commercial authenticity requires recapture against the source and review; supplied hashes alone cannot prove provenance.',
      ],
    },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const args = process.argv.slice(2);
    assert.ok(
      (args.length === 1 || (args.length === 2 && args[1] === '--bindings')) &&
        !args[0].startsWith('-'),
      'SNAPSHOT_FILE_AND_OPTIONAL_BINDINGS_ONLY',
    );
    const result = reconcile(JSON.parse(readFileSync(args[0], 'utf8')));
    process.stdout.write(
      `${JSON.stringify(args[1] ? result.bindings : result.report, null, 2)}\n`,
    );
  } catch (error) {
    console.error(
      error instanceof assert.AssertionError
        ? error.message
        : 'RECONCILIATION_FAILED',
    );
    process.exitCode = 1;
  }
}
