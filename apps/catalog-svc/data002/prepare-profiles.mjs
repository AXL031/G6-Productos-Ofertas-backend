import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export const fields = ['peso_kg', 'largo_cm', 'ancho_cm', 'alto_cm'];
const literal = (value) =>
  value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
const json = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
const emit = (file, value) => writeFileSync(resolve(root, file), value + '\n');
const referenceReviews = json('sources/model-color-review.json');

export function resolveProfiles(source, audit) {
  const rows = source.profiles;
  if (rows.length !== 55 || new Set(rows.map((r) => r.sku)).size !== 55)
    throw Error('DATA002_SOURCE_REQUIRES_55_UNIQUE_SKUS');
  const sellable = audit.identities.filter(
    (s) =>
      s.variant_id ||
      audit.products.some((p) => p.id === s.product_id && !p.tiene_variantes),
  );
  if (sellable.length !== 55) throw Error('DATA002_SELLABLE_SET_CHANGED');
  const profiles = rows.map((row) => {
    for (const field of fields) {
      if (
        typeof row[field] !== 'string' ||
        !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(row[field]) ||
        !Number.isFinite(Number(row[field])) ||
        !(Number(row[field]) > 0)
      )
        throw Error('DATA002_INVALID_MEASURE:' + row.sku + ':' + field);
    }
    const matches = audit.identities.filter((s) => s.sku === row.sku);
    if (matches.length !== 1)
      throw Error('DATA002_SKU_IDENTITY_CONFLICT:' + row.sku);
    const identity = matches[0];
    const variant = audit.variants.find((v) => v.id === identity.variant_id);
    const product = audit.products.find(
      (p) => p.id === (variant?.product_id ?? identity.product_id),
    );
    if (
      !product ||
      (identity.variant_id &&
        (!variant ||
          !product.tiene_variantes ||
          variant.sku !== row.sku ||
          identity.product_id !== null)) ||
      (identity.product_id &&
        (product.tiene_variantes ||
          product.sku_base !== row.sku ||
          identity.variant_id !== null))
    )
      throw Error('DATA002_NON_SELLABLE_OR_OWNER_CONFLICT:' + row.sku);
    const type = variant ? 'VARIANTE' : 'PRODUCTO_SIMPLE';
    if (row.tipo_unidad !== type)
      throw Error('DATA002_PRESENTATION_CONFLICT:' + row.sku);
    return {
      ...row,
      modelo_ref_original: row.modelo_ref,
      modelo_ref:
        referenceReviews.find((r) => row.sku.startsWith(r.prefix))?.code ??
        row.modelo_ref,
      sku_identity_id: identity.id,
      product_id: product.id,
      variant_id: variant?.id ?? null,
      sku_base: product.sku_base,
      tipo_unidad: type,
    };
  });
  if (
    new Set(profiles.map((p) => p.sku_identity_id)).size !== 55 ||
    sellable.some((s) => !profiles.some((p) => p.sku_identity_id === s.id))
  )
    throw Error('DATA002_COVERAGE_CONFLICT');
  return profiles;
}

export function profileSql(profiles) {
  const columns = [
    'sku',
    'sku_identity_id',
    'product_id',
    'variant_id',
    'sku_base',
    'tipo_unidad',
    ...fields,
  ];
  const map =
    '(VALUES\n' +
    profiles
      .map(
        (p) =>
          '  (' +
          columns
            .map((c) => literal(p[c]) + (fields.includes(c) ? '::numeric' : ''))
            .join(', ') +
          ')',
      )
      .join(',\n') +
    '\n) AS m(' +
    columns.join(', ') +
    ')';
  const identityOk = `EXISTS (SELECT 1 FROM catalog.sku_identity s
    JOIN catalog.products p ON p.id=m.product_id::uuid
    LEFT JOIN catalog.variants v ON v.id=m.variant_id::uuid
    WHERE s.id=m.sku_identity_id::uuid AND s.sku=m.sku AND p.sku_base=m.sku_base AND (
      (m.tipo_unidad='PRODUCTO_SIMPLE' AND NOT p.tiene_variantes AND m.variant_id IS NULL
        AND s.product_id=p.id AND s.variant_id IS NULL AND p.sku_base=m.sku)
      OR (m.tipo_unidad='VARIANTE' AND p.tiene_variantes AND v.product_id=p.id AND v.sku=m.sku
        AND s.variant_id=v.id AND s.product_id IS NULL)))`;
  const positive = fields
    .map(
      (f) =>
        `m.${f} IS NOT NULL AND m.${f}>0 AND m.${f} NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)`,
    )
    .join(' AND ');
  const equal = fields
    .map((f) => `f.${f} IS NOT DISTINCT FROM m.${f}`)
    .join(' AND ');
  const existsEqual = `EXISTS (SELECT 1 FROM catalog.sku_physical_profiles f WHERE f.sku_identity_id=m.sku_identity_id::uuid AND ${equal})`;
  const exists = `EXISTS (SELECT 1 FROM catalog.sku_physical_profiles f WHERE f.sku_identity_id=m.sku_identity_id::uuid)`;
  const otherTables = [
    'products',
    'variants',
    'sku_identity',
    'product_images',
    'variant_images',
    'product_attribute_values',
    'variant_attribute_values',
    'product_identifying_characteristics',
    'activation_checks',
    'master_barriers',
    'outbox',
    'inbox',
  ];
  const state =
    '(SELECT jsonb_build_object(' +
    otherTables
      .map(
        (t) =>
          `${literal(t)},(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM catalog.${t} t)`,
      )
      .join(',\n') +
    '))';
  return {
    preflight: `-- Solo SELECT. READY significa insertable, no autorización ni activación.
SELECT m.*, 'PENDING_INTRINSIC_OR_ACADEMIC_EXCEPTION' AS semantic_status,
  CASE WHEN NOT (${positive}) THEN 'INVALID_MEASURE'
  WHEN NOT (${identityOk}) THEN 'OWNER_CONFLICT'
  WHEN ${existsEqual} THEN 'ALREADY_APPLIED'
  WHEN ${exists} THEN 'PROFILE_CONFLICT' ELSE 'READY' END AS status FROM ${map} ORDER BY m.sku;`,
    apply: `-- PROPUESTA ACADÉMICA #12. PENDIENTE_APROBACION_MARCO para Supabase compartido.
-- Solo INSERT en catalog.sku_physical_profiles. No crear identidades ni sobrescribir perfiles.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $profiles$
DECLARE m record; before_state jsonb;
BEGIN
  IF current_setting('catalog.data002_physical_semantics',true) IS DISTINCT FROM 'ACADEMIC_LOGISTIC_EXCEPTION_APPROVED'
    THEN RAISE EXCEPTION 'DATA002_PHYSICAL_SEMANTICS_NOT_APPROVED'; END IF;
  IF current_user <> 'po_catalog_owner' OR NOT EXISTS (SELECT 1 FROM pg_namespace
    WHERE nspname='catalog' AND pg_get_userbyid(nspowner)=current_user)
    THEN RAISE EXCEPTION 'DATA002_REQUIRE_CATALOG_OWNER'; END IF;
  LOCK TABLE ${[...otherTables, 'sku_physical_profiles'].map((t) => 'catalog.' + t).join(', ')} IN SHARE ROW EXCLUSIVE MODE;
  before_state := ${state};
  IF (SELECT count(*)<>55 OR count(DISTINCT sku_identity_id)<>55 OR count(DISTINCT sku)<>55 FROM ${map})
    THEN RAISE EXCEPTION 'DATA002_PROFILE_SCOPE_CONFLICT'; END IF;
  FOR m IN SELECT * FROM ${map} LOOP
    IF NOT (${positive}) THEN RAISE EXCEPTION 'DATA002_INVALID_PROFILE_MEASURE: %',m.sku; END IF;
    IF NOT (${identityOk}) THEN RAISE EXCEPTION 'DATA002_PROFILE_OWNER_CONFLICT: %',m.sku; END IF;
    IF ${exists} AND NOT (${existsEqual}) THEN RAISE EXCEPTION 'DATA002_PROFILE_CONFLICT: %',m.sku; END IF;
    INSERT INTO catalog.sku_physical_profiles(sku_identity_id,peso_kg,largo_cm,ancho_cm,alto_cm)
      SELECT m.sku_identity_id::uuid,m.peso_kg,m.largo_cm,m.ancho_cm,m.alto_cm WHERE NOT (${exists});
    IF NOT (${existsEqual}) THEN RAISE EXCEPTION 'DATA002_PROFILE_POSTCHECK: %',m.sku; END IF;
  END LOOP;
  IF before_state IS DISTINCT FROM ${state} THEN RAISE EXCEPTION 'DATA002_PROFILE_UNEXPECTED_MUTATION'; END IF;
END
$profiles$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;`,
    postcheck: `-- Solo SELECT: 55 filas, ok=true; guardar UUID nuevos para recuperación aprobada.
SELECT m.sku,m.sku_identity_id,f.id AS profile_id,f.peso_kg,f.largo_cm,f.ancho_cm,f.alto_cm,
  (${identityOk} AND ${positive} AND ${existsEqual}) AS ok
FROM ${map} LEFT JOIN catalog.sku_physical_profiles f ON f.sku_identity_id=m.sku_identity_id::uuid ORDER BY m.sku;
SELECT count(*) AS perfiles_en_bases_no_vendibles FROM catalog.sku_physical_profiles f
  JOIN catalog.sku_identity s ON s.id=f.sku_identity_id JOIN catalog.products p ON p.id=s.product_id WHERE p.tiene_variantes;`,
  };
}

export function prepareProfiles() {
  const source = json('sources/physical-profiles-extracted.json');
  const workbookHash = createHash('sha256')
    .update(
      readFileSync(resolve(root, 'sources/physical-profiles-academic.xlsx')),
    )
    .digest('hex');
  if (workbookHash !== source.source.sha256)
    throw Error('DATA002_WORKBOOK_HASH_CONFLICT');
  const audit = json('evidence/profiles-readonly.json');
  const profiles = resolveProfiles(source, audit);
  const sql = profileSql(profiles);
  const manifest = {
    issue: 12,
    owner: 'Gabriel Poma',
    project_id: 'slzglmtiyrzygpkiuthf',
    schema: 'catalog',
    table: 'sku_physical_profiles',
    source: source.source,
    authorization: {
      academic_estimates:
        'AUTORIZADAS_POR_INSTRUCCION_EXPLICITA_DEL_USUARIO_2026_11_03',
      shared_execution: 'PENDIENTE_APROBACION_MARCO',
      semantic_compatibility: 'PENDING_INTRINSIC_OR_ACADEMIC_EXCEPTION',
      photos: 'REQUIERE_CORRESPONDENCIA_SKU_COLOR_FOTO_SEGUN_AUDITORIA',
    },
    audited_at: audit.audited_at,
    baseline_profiles: audit.profiles?.length ?? 0,
    profiles,
  };
  emit('profile-manifest.json', JSON.stringify(manifest, null, 2));
  emit('profiles-preflight.sql', sql.preflight);
  emit('profiles-apply-proposed.sql', sql.apply);
  emit('profiles-postcheck.sql', sql.postcheck);
  const csv = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const keys = [
    'sku',
    'sku_identity_id',
    'product_id',
    'variant_id',
    'tipo_unidad',
    'modelo_ref_original',
    'modelo_ref',
    ...fields,
    'source_row',
    'origen_peso',
    'origen_largo',
    'origen_ancho',
    'origen_alto',
    'url_fuente_medidas',
    'presentacion_fisica',
    'observaciones',
  ];
  emit(
    'profiles-proposed.csv',
    [keys, ...profiles.map((p) => keys.map((k) => p[k]))]
      .map((r) => r.map(csv).join(','))
      .join('\n'),
  );
  return manifest;
}
