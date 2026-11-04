import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
const emit = (file, data) =>
  writeFileSync(resolve(root, file), JSON.stringify(data, null, 2) + '\n');
const csv = (rows) =>
  rows
    .map((row) =>
      row
        .map((v) => '"' + String(v ?? '').replaceAll('"', '""') + '"')
        .join(','),
    )
    .join('\n') + '\n';

export function reviewData() {
  const profiles = read('profile-manifest.json').profiles;
  const source = read('sources/physical-profiles-extracted.json');
  const audit = read('evidence/supabase-readonly.json');
  const live = read('evidence/audit-followup-readonly.json');
  const http = read('evidence/storage-image-http.json');
  const runx = read('evidence/jd9558-image-correspondence.json');
  const references = read('sources/model-color-review.json');
  const images = read('image-map.json');
  const historical = JSON.parse(
    readFileSync(
      resolve(
        root,
        '../../../scripts/seed/mcp/catalog/002_manifest_catalogo.json',
      ),
      'utf8',
    ),
  );
  const groups = new Map();
  for (const p of profiles) {
    const values = ['peso_kg', 'largo_cm', 'ancho_cm', 'alto_cm'].map(
      (f) => p[f],
    );
    const key = values.join('|');
    if (!groups.has(key)) groups.set(key, { measures: values, skus: [] });
    groups.get(key).skus.push(p.sku);
    const original = source.profiles.find((row) => row.sku === p.sku);
    if (
      values.some(
        (v, i) =>
          v !== original[['peso_kg', 'largo_cm', 'ancho_cm', 'alto_cm'][i]],
      )
    )
      throw Error('DATA002_ORIGINAL_MEASURE_CHANGED');
  }
  const templates = [...groups.values()].map((group, i) => ({
    template: 'T' + String(i + 1).padStart(2, '0'),
    ...group,
    count: group.skus.length,
  }));
  const quality = {
    profiles: profiles.length,
    values: profiles.length * 4,
    estimates: 213,
    published_not_homologated: 7,
    distinct_templates: templates.length,
    skus_sharing_template: templates
      .filter((t) => t.count > 1)
      .reduce((n, t) => n + t.count, 0),
    packaged_presentations: profiles.filter((p) => p.categoria !== 'balon')
      .length,
    unpackaged_balls: profiles.filter((p) => p.categoria === 'balon').length,
    methodology:
      'Heurística declarada por el usuario: categoría, talla, modelo y presentación logística; sin medición directa ni ajuste estadístico; plantillas reutilizadas sin diferencias artificiales.',
    templates,
  };
  if (
    quality.distinct_templates !== 27 ||
    quality.skus_sharing_template !== 39 ||
    quality.packaged_presentations !== 51
  )
    throw Error('DATA002_QUALITY_RECONCILIATION');
  const origins = profiles.flatMap((p) =>
    ['origen_peso', 'origen_largo', 'origen_ancho', 'origen_alto'].map(
      (f) => p[f],
    ),
  );
  quality.estimates = origins.filter(
    (v) => v === 'ESTIMACION_ACADEMICA',
  ).length;
  quality.published_not_homologated = origins.filter(
    (v) => v === 'PUBLICADO_NO_HOMOLOGADO',
  ).length;
  if (quality.estimates !== 213 || quality.published_not_homologated !== 7)
    throw Error('DATA002_ORIGIN_COUNTS_CHANGED');
  emit('evidence/physical-quality-review.json', quality);
  writeFileSync(
    resolve(root, 'template-reuse.csv'),
    csv([
      [
        'plantilla',
        'peso_kg',
        'largo_cm',
        'ancho_cm',
        'alto_cm',
        'cantidad_sku',
        'sku',
      ],
      ...templates.flatMap((t) =>
        t.skus.map((sku) => [t.template, ...t.measures, t.count, sku]),
      ),
    ]),
  );
  const rows = profiles.map((p) => {
    const ref = references.find((r) => p.sku.startsWith(r.prefix));
    const v = audit.variants.find((v) => v.id === p.variant_id);
    const attrs = v
      ? audit.variant_attributes.filter((a) => a.variant_id === v.id)
      : audit.product_attributes.filter((a) => a.product_id === p.product_id);
    const ca = attrs.find(
      (a) => a.caracteristica_id === 'acee6db1-ba1c-f020-caf8-f439b09556ff',
    );
    const color =
      audit.values.find((value) => value.id === ca?.valor_id)?.nombre ??
      'SIN_ATRIBUTO_COLOR';
    const patch = images.images.find((i) => i.sku === p.sku);
    const actual = v
      ? live.variant_images.find((i) => i.variant_id === v.id)
      : live.product_images?.find((i) => i.product_id === p.product_id);
    const url =
      patch?.url ?? (p.sku === 'NIK-PITCH-05' ? images.pitch.url : actual?.url);
    const object = http.find((o) => o.url === url);
    if (!object) throw Error('DATA002_IMAGE_EVIDENCE_MISSING:' + p.sku);
    const historic = historical.productos.find((h) => h.id === p.product_id);
    const isRunx = p.sku.startsWith('ADI-RUNX-');
    if (
      isRunx &&
      (url !== runx.stored_image.url ||
        object.sha256 !== runx.stored_image.sha256 ||
        object.sha256 !== runx.official_image.sha256 ||
        runx.stored_image.status !== 200 ||
        runx.official_image.status !== 200)
    )
      throw Error('DATA002_RUNX_IMAGE_EVIDENCE_MISMATCH');
    return {
      sku: p.sku,
      sku_identity_id: p.sku_identity_id,
      variant_id: p.variant_id,
      manufacturer_code: p.modelo_ref,
      original_model_reference: p.modelo_ref_original,
      catalog_color: color,
      reference_color: ref?.color ?? color,
      reference_url: ref?.url ?? historic?.evidencia_comercial?.[0],
      reference_evidence:
        ref?.evidence ?? 'FUENTE_HISTORICA_MANIFIESTO_002_005',
      image_url: url,
      image_sha256: object.sha256,
      http_status: object.status,
      link_status: patch
        ? 'PROPUESTA_A_REEMPLAZO_PLACEHOLDER'
        : p.sku === 'NIK-PITCH-05'
          ? 'PROPUESTA_A_IMAGEN_PRODUCTO'
          : 'EXISTENTE',
      visual_review: isRunx
        ? 'IMAGEN_IDENTICA_A_FUENTE_OFICIAL_POR_SHA256'
        : color === 'SIN_ATRIBUTO_COLOR'
          ? 'ASOCIACION_POR_NOMBRE_Y_SKU; FALTA_COLOR_EN_CATALOGO'
          : 'ASOCIACION_POR_NOMBRE_Y_SKU',
      limitation:
        'Asociación documental por nombre y SKU; no acredita inspección visual individual, talla, medición, etiqueta física ni autenticidad de mercancía. JD9558 dispone además de igualdad binaria con la imagen oficial documentada en evidence/jd9558-image-correspondence.json.',
    };
  });
  emit('reference-image-review.json', rows);
  const keys = Object.keys(rows[0]);
  writeFileSync(
    resolve(root, 'reference-image-review.csv'),
    csv([keys, ...rows.map((row) => keys.map((key) => row[key]))]),
  );
  const reconciliation = read('evidence/reconciliation.json');
  emit('attribute-review.json', {
    normative:
      'OpenAPI Atributo.valor: {} acepta JSON null; modelo físico distingue JSON null de SQL NULL. Para LISTA, Taxonomy y CatalogMasterClient validan valor_id; identifying_key usa valor_id.',
    list_values_with_json_null: live.null_attributes.map((a) => ({
      ...a,
      status:
        a.value_active && a.value_belongs
          ? 'VALID_LIST_VALUE_ID_WITH_JSON_NULL'
          : 'REFERENCE_CONFLICT',
      normalization_required: false,
    })),
    conclusion:
      'No hay obligación contractual de convertir los 12 JSON null con valor_id válido a objetos redundantes. No son valores desconocidos y no se propone UPDATE. Si cambian las reglas o una referencia deja de ser válida, reevaluar individualmente.',
    missing_product_identifying_associations:
      reconciliation.identifying_findings,
    missing_pitch_attributes: reconciliation.attribute_findings.filter(
      (a) => a.sku === 'NIK-PITCH-05',
    ),
    pitch_proposal:
      'Tratar Talla 5 y color de la foto FZ2636-101 en propuesta separada: Talla 5 tiene referencia activa; color debe seleccionarse explícitamente de Taxonomy (no inventar ID ni deducirlo del SKU).',
  });
  return quality;
}
