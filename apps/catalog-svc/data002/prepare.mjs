import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfiles } from './prepare-profiles.mjs';
import { reviewData } from './review-data.mjs';

// Generación offline: nunca abre conexiones ni ejecuta SQL.
const root = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const audit = JSON.parse(read('evidence/supabase-readonly.json'));
const academicProfiles = prepareProfiles();
const manifest = JSON.parse(
  read('../../../scripts/seed/mcp/catalog/002_manifest_catalogo.json'),
);
const sha = (s) =>
  createHash('sha256').update(s.replaceAll('\r\n', '\n')).digest('hex');
const emit = (name, text) => writeFileSync(resolve(root, name), text + '\n');
const literal = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const publicBase =
  'https://slzglmtiyrzygpkiuthf.supabase.co/storage/v1/object/public/catalog-products/';
const placeholder = 'https://placehold.co/800x800/png?text=Imagen+referencial';
const expected = [
  [
    'ADI-ENT22-AZU-M',
    'c9b5f3d3-542e-4c1b-bd87-e50a53aa0703',
    'adidas-entrada22-azul.jpg',
  ],
  [
    'ADI-RF3-GRI-38',
    'bdf64a75-0ee8-4fd2-aeae-e85e27c67cae',
    'adidas-runfalcon3-gris.jpg',
  ],
  [
    'ADI-RF3-GRI-39',
    '739bdf11-ce20-4f19-a49e-8fa09bda60f3',
    'adidas-runfalcon3-gris.jpg',
  ],
  [
    'NIK-REV7-NEG-41',
    'e807b012-00ba-4d17-a4e5-f47546cd8980',
    'nike-revolution7-negro.jpg',
  ],
  [
    'NIK-REV7-NEG-42',
    'aba3e97a-6575-4c13-81e7-fe35a2e14d0a',
    'nike-revolution7-negro.jpg',
  ],
  [
    'PUM-ULP-NEG-42',
    'e26d7736-b820-4e43-b92b-4f95cc773186',
    'puma-ultra-play-negro.jpg',
  ],
];
function objectFor(file) {
  const object = audit.storage.find((s) => s.name === file);
  if (
    !object ||
    !(Number(object.metadata.size) > 0) ||
    !object.metadata.mimetype.startsWith('image/')
  )
    throw Error('Objeto inválido: ' + file);
  return {
    file,
    storage_id: object.id,
    etag: object.metadata.eTag,
    url: publicBase + file,
  };
}
const images = expected.map(([sku, image_id, file]) => {
  const image = audit.variant_images.find((i) => i.id === image_id);
  const variant = audit.variants.find((v) => v.sku === sku);
  if (
    !image ||
    !variant ||
    image.variant_id !== variant.id ||
    image.url !== placeholder
  )
    throw Error('Snapshot divergente: ' + sku);
  return {
    sku,
    image_id,
    variant_id: variant.id,
    product_id: variant.product_id,
    old_url: placeholder,
    ...objectFor(file),
  };
});
const pitch = {
  sku: 'NIK-PITCH-05',
  product_id: 'abab3400-46eb-58f7-78d5-8204418b60d9',
  ...objectFor('nike-pitch-talla.jpg'),
};
const covers = manifest.productos
  .filter((p) => p.tiene_variantes)
  .map((p) => {
    const candidate = audit.variant_images
      .filter((i) =>
        audit.variants.some(
          (v) => v.id === i.variant_id && v.product_id === p.id,
        ),
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    const presentation = p.presentaciones.find(
      (v) => v.url_publica === candidate?.url,
    );
    if (!presentation || !p.evidencia_comercial?.length)
      throw Error('Portada sin fuente: ' + p.id);
    return {
      product_id: p.id,
      sku: p.sku_base,
      source_variant_id: candidate.variant_id,
      source_image_id: candidate.id,
      evidence: p.evidencia_comercial,
      verification:
        p.sku_base === 'ADI-RUNX-JD9558-BASE'
          ? 'IMAGEN_IDENTICA_A_FUENTE_OFICIAL_POR_SHA256; VER evidence/jd9558-image-correspondence.json'
          : 'ASOCIACION_POR_NOMBRE_Y_SKU; VER reference-image-review.csv',
      ...objectFor(presentation.archivo_storage),
    };
  });
const blockedCovers = audit.products
  .filter(
    (p) => p.tiene_variantes && !covers.some((c) => c.product_id === p.id),
  )
  .map((p) => ({
    product_id: p.id,
    sku: p.sku_base,
    status: 'PENDING_SEPARATE_PROPOSAL',
    reason:
      'Mantener como propuesta separada de las portadas originales según auditoría; asociación documental en reference-image-review.csv.',
  }));
emit('image-map.json', JSON.stringify({ images, pitch }, null, 2));
emit(
  'cover-map.json',
  JSON.stringify(
    {
      covers,
      pending_proposal: blockedCovers,
      image_conflicts: [],
    },
    null,
    2,
  ),
);

function mapping(rows, cols) {
  return (
    '(VALUES\n' +
    rows
      .map((r) => '  (' + cols.map((c) => literal(r[c])).join(', ') + ')')
      .join(',\n') +
    '\n) AS m(' +
    cols.join(', ') +
    ')'
  );
}
const imageMap = mapping(images, [
  'sku',
  'image_id',
  'variant_id',
  'product_id',
  'old_url',
  'file',
  'storage_id',
  'etag',
  'url',
]);
const coverMap = mapping(covers, [
  'sku',
  'product_id',
  'source_variant_id',
  'source_image_id',
  'file',
  'storage_id',
  'etag',
  'url',
]);
const storageOk = `EXISTS (SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
    WHERE b.id='catalog-products' AND b.public AND o.name=m.file AND o.id=m.storage_id::uuid
      AND o.metadata->>'eTag'=m.etag AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%')`;
const imageOk = `EXISTS (SELECT 1 FROM catalog.variant_images i JOIN catalog.variants v ON v.id=i.variant_id
    JOIN catalog.products p ON p.id=v.product_id JOIN catalog.sku_identity s ON s.variant_id=v.id
    WHERE i.id=m.image_id::uuid AND v.id=m.variant_id::uuid AND p.id=m.product_id::uuid
      AND v.sku=m.sku AND s.sku=m.sku AND p.tiene_variantes AND i.url IN (m.old_url,m.url))`;
const coverOk = `EXISTS (SELECT 1 FROM catalog.variant_images i JOIN catalog.variants v ON v.id=i.variant_id
    JOIN catalog.products p ON p.id=v.product_id WHERE i.id=m.source_image_id::uuid
    AND v.id=m.source_variant_id::uuid AND p.id=m.product_id::uuid AND p.sku_base=m.sku
    AND p.tiene_variantes AND i.url=m.url)`;
const pitchOk = `EXISTS (SELECT 1 FROM catalog.products p JOIN catalog.sku_identity s ON s.product_id=p.id
    WHERE p.id=${literal(pitch.product_id)}::uuid AND p.sku_base=${literal(pitch.sku)} AND s.sku=p.sku_base AND NOT p.tiene_variantes)
    AND EXISTS (SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
      WHERE b.id='catalog-products' AND b.public AND o.id=${literal(pitch.storage_id)}::uuid
      AND o.name=${literal(pitch.file)} AND o.metadata->>'eTag'=${literal(pitch.etag)}
      AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%')
    AND (NOT EXISTS (SELECT 1 FROM catalog.product_images WHERE product_id=${literal(pitch.product_id)}::uuid)
      OR (SELECT count(*)=1 AND bool_and(url=${literal(pitch.url)} AND principal AND posicion=0)
          FROM catalog.product_images WHERE product_id=${literal(pitch.product_id)}::uuid))`;
emit(
  'images-preflight.sql',
  `-- Solo SELECT; ERROR/READY/ALREADY_APPLIED. No autoriza ejecutar DML.
SELECT m.*, CASE WHEN ${storageOk} AND ${imageOk} THEN
  CASE WHEN (SELECT url FROM catalog.variant_images WHERE id=m.image_id::uuid)=m.url THEN 'ALREADY_APPLIED' ELSE 'READY' END
  ELSE 'CONFLICT' END AS status FROM ${imageMap};
SELECT ${pitchOk} AS pitch_preflight_ok;`,
);
const invariant = `(SELECT jsonb_build_object(
  'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM catalog.products p),
  'variants',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM catalog.variants v),
  'sku_identity',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM catalog.sku_identity s),
  'profiles',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM catalog.sku_physical_profiles f),
  'checks',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM catalog.activation_checks c)))`;
function transaction(body) {
  return `-- PROPUESTA PENDIENTE_APROBACION_MARCO. Ejecutar completa con ON_ERROR_STOP.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $data002$
DECLARE m record; before_state jsonb;
BEGIN
  IF current_user <> 'po_catalog_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname='catalog' AND pg_get_userbyid(nspowner)=current_user
  ) THEN RAISE EXCEPTION 'DATA002_REQUIRE_CATALOG_OWNER'; END IF;
  LOCK TABLE catalog.products,catalog.variants,catalog.sku_identity,catalog.product_images,
    catalog.variant_images,catalog.sku_physical_profiles,catalog.activation_checks IN SHARE ROW EXCLUSIVE MODE;
  before_state := ${invariant};
${body}
  IF before_state IS DISTINCT FROM ${invariant} THEN RAISE EXCEPTION 'DATA002_UNEXPECTED_MUTATION'; END IF;
END
$data002$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;`;
}
emit(
  'images-apply-proposed.sql',
  transaction(`  FOR m IN SELECT * FROM ${imageMap} LOOP
    IF NOT (${storageOk} AND ${imageOk}) THEN RAISE EXCEPTION 'DATA002_IMAGE_CONFLICT: %',m.sku; END IF;
    UPDATE catalog.variant_images SET url=m.url WHERE id=m.image_id::uuid AND url=m.old_url;
    IF NOT EXISTS (SELECT 1 FROM catalog.variant_images WHERE id=m.image_id::uuid AND url=m.url)
      THEN RAISE EXCEPTION 'DATA002_IMAGE_POSTCHECK: %',m.sku; END IF;
  END LOOP;
  IF NOT (${pitchOk}) THEN RAISE EXCEPTION 'DATA002_PITCH_CONFLICT'; END IF;
  INSERT INTO catalog.product_images(product_id,url,principal,posicion)
    SELECT ${literal(pitch.product_id)}::uuid,${literal(pitch.url)},true,0
    WHERE NOT EXISTS (SELECT 1 FROM catalog.product_images WHERE product_id=${literal(pitch.product_id)}::uuid);
  IF NOT (${pitchOk}) OR NOT EXISTS (SELECT 1 FROM catalog.product_images
    WHERE product_id=${literal(pitch.product_id)}::uuid AND url=${literal(pitch.url)} AND principal AND posicion=0)
    THEN RAISE EXCEPTION 'DATA002_PITCH_POSTCHECK'; END IF;`),
);
emit(
  'images-postcheck.sql',
  `-- Cada fila debe resultar true; no exige totales históricos de portadas.
SELECT m.sku, ${storageOk} AND ${imageOk} AND EXISTS (SELECT 1 FROM catalog.variant_images
  WHERE id=m.image_id::uuid AND url=m.url) AS ok FROM ${imageMap};
SELECT ${pitchOk} AND EXISTS (SELECT 1 FROM catalog.product_images
  WHERE product_id=${literal(pitch.product_id)}::uuid AND url=${literal(pitch.url)} AND principal AND posicion=0) AS pitch_ok;
SELECT id,product_id,url,principal,posicion,created_at FROM catalog.product_images WHERE product_id=${literal(pitch.product_id)}::uuid;`,
);
emit(
  'covers-preflight.sql',
  `-- Mapeo documental de 12 padres; JD9558 coincide por SHA-256 con la imagen oficial.
SELECT m.*, ${storageOk} AND ${coverOk} AS source_ok,
  CASE WHEN EXISTS (SELECT 1 FROM catalog.product_images i JOIN storage.objects o
    ON i.url=${literal(publicBase)}||o.name AND o.bucket_id='catalog-products'
    WHERE i.product_id=m.product_id::uuid AND i.url=m.url AND (o.metadata->>'size')::bigint>0)
    THEN 'EXISTING_VALID_COVER' ELSE 'MISSING_COVER' END AS status FROM ${coverMap};`,
);
emit(
  'covers-apply-proposed.sql',
  transaction(`  FOR m IN SELECT * FROM ${coverMap} LOOP
    IF NOT (${storageOk} AND ${coverOk}) THEN RAISE EXCEPTION 'DATA002_COVER_SOURCE_CONFLICT: %',m.sku; END IF;
    IF NOT EXISTS (SELECT 1 FROM catalog.product_images WHERE product_id=m.product_id::uuid) THEN
      INSERT INTO catalog.product_images(product_id,url,principal,posicion) VALUES(m.product_id::uuid,m.url,true,0);
    ELSIF NOT EXISTS (SELECT 1 FROM catalog.product_images i JOIN storage.objects o
      ON i.url=${literal(publicBase)}||o.name AND o.bucket_id='catalog-products'
      WHERE i.product_id=m.product_id::uuid AND i.url=m.url AND (o.metadata->>'size')::bigint>0 AND o.metadata->>'mimetype' LIKE 'image/%') THEN
      RAISE EXCEPTION 'DATA002_EXISTING_COVER_UNVERIFIED: %',m.sku;
    END IF;
  END LOOP;`),
);
emit(
  'covers-postcheck.sql',
  `-- 12 padres mapeados, incluido JD9558; cuatro adicionales separados.
SELECT m.sku, ${coverOk} AND ${storageOk} AND EXISTS (SELECT 1 FROM catalog.product_images i JOIN storage.objects o
  ON i.url=${literal(publicBase)}||o.name AND o.bucket_id='catalog-products'
  WHERE i.product_id=m.product_id::uuid AND i.url=m.url AND (o.metadata->>'size')::bigint>0
    AND o.metadata->>'mimetype' LIKE 'image/%') AS ok FROM ${coverMap};
SELECT i.id,i.product_id,i.url,i.principal,i.posicion,i.created_at FROM catalog.product_images i
  JOIN ${coverMap} ON i.product_id=m.product_id::uuid ORDER BY i.product_id,i.id;`,
);

const sellable = audit.identities.filter(
  (s) =>
    s.variant_id ||
    !audit.products.find((p) => p.id === s.product_id).tiene_variantes,
);
const csv = (rows) =>
  rows
    .map((r) =>
      r.map((v) => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(','),
    )
    .join('\n');
const header = [
  'producto_id',
  'producto',
  'sku_identity_id',
  'sku',
  'presentacion',
  'perfil_existe',
  'peso_kg',
  'largo_cm',
  'ancho_cm',
  'alto_cm',
  'estado_catalogo',
  'pricing',
  'inventory',
  'fuente_medidas',
  'estado',
  'bloqueos',
];
emit(
  'physical-profiles.csv',
  csv([
    header,
    ...sellable.map((s) => {
      const v = audit.variants.find((v) => v.id === s.variant_id);
      const p = audit.products.find(
        (p) => p.id === (v?.product_id ?? s.product_id),
      );
      const f = audit.profiles?.find((f) => f.sku_identity_id === s.id);
      const proposed = academicProfiles.profiles.find(
        (p) => p.sku_identity_id === s.id,
      );
      return [
        p.id,
        p.nombre,
        s.id,
        s.sku,
        v ? 'VARIANTE' : 'SIMPLE',
        !!f,
        proposed.peso_kg,
        proposed.largo_cm,
        proposed.ancho_cm,
        proposed.alto_cm,
        v?.estado ?? p.estado,
        'NO_REGISTRADA',
        'NO_REGISTRADA',
        academicProfiles.source.file +
          '!CARGA_55!F' +
          proposed.source_row +
          ':I' +
          proposed.source_row,
        'STRUCTURAL_READY_SEMANTICS_PENDING',
        'Pendiente ejecutar carga autorizada; Pricing producto; Inventory SKU; imagen/atributos según auditoría',
      ];
    }),
  ]),
);
emit(
  'physical-input-template.csv',
  csv([
    [
      'sku_identity_id',
      'sku',
      'peso_kg',
      'largo_cm',
      'ancho_cm',
      'alto_cm',
      'fuente_autoritativa',
      'fecha_medicion',
      'responsable',
      'evidencia',
    ],
    ...sellable.map((s) => [s.id, s.sku, '', '', '', '', '', '', '', '']),
  ]),
);
const ids = new Set(manifest.productos.map((p) => p.id));
const missingReferences = [];
for (const p of audit.products) {
  for (const [field, group] of [
    ['marca_id', 'brands'],
    ['categoria_id', 'categories'],
    ['tipo_producto_id', 'types'],
  ]) {
    if (!audit[group].some((m) => m.id === p[field] && m.estado === 'ACTIVO'))
      missingReferences.push({ product_id: p.id, field, value: p[field] });
  }
}
const attributeFindings = [];
for (const s of sellable) {
  const v = audit.variants.find((v) => v.id === s.variant_id);
  const p = audit.products.find(
    (p) => p.id === (v?.product_id ?? s.product_id),
  );
  const attrs = v
    ? audit.variant_attributes.filter((a) => a.variant_id === v.id)
    : audit.product_attributes.filter((a) => a.product_id === p.id);
  for (const rel of audit.associations.filter(
    (a) =>
      a.tipo_producto_id === p.tipo_producto_id &&
      a.estado === 'ACTIVO' &&
      a.obligatoria,
  )) {
    if (!attrs.some((a) => a.caracteristica_id === rel.caracteristica_id))
      attributeFindings.push({
        sku: s.sku,
        reason: 'MISSING_REQUIRED_ATTRIBUTE',
        characteristic: rel.caracteristica_id,
      });
  }
  for (const a of attrs) {
    const rel = audit.associations.find(
      (r) =>
        r.tipo_producto_id === p.tipo_producto_id &&
        r.caracteristica_id === a.caracteristica_id &&
        r.estado === 'ACTIVO',
    );
    const characteristic = audit.characteristics.find(
      (c) => c.id === a.caracteristica_id && c.estado === 'ACTIVO',
    );
    const value = audit.values.find(
      (v) =>
        v.id === a.valor_id &&
        v.caracteristica_id === a.caracteristica_id &&
        v.estado === 'ACTIVO',
    );
    if (
      !rel ||
      !characteristic ||
      (a.valor_id && !value) ||
      (a.valor === null && !(characteristic?.tipo === 'LISTA' && value))
    )
      attributeFindings.push({
        sku: s.sku,
        attribute_id: a.id,
        reason: !rel
          ? 'MISSING_TYPE_ASSOCIATION'
          : !characteristic
            ? 'INACTIVE_CHARACTERISTIC'
            : a.valor === null
              ? 'JSON_NULL_VALUE'
              : 'INVALID_VALUE_REFERENCE',
      });
  }
}
const diff = [];
const identifyingFindings = audit.products
  .filter((p) => p.tiene_variantes)
  .flatMap((p) => {
    const used = new Set(
      audit.variant_attributes
        .filter(
          (a) =>
            a.es_identificador &&
            audit.variants.some(
              (v) => v.id === a.variant_id && v.product_id === p.id,
            ),
        )
        .map((a) => a.caracteristica_id),
    );
    return [...used]
      .filter(
        (id) =>
          !audit.identifying_characteristics.some(
            (a) => a.product_id === p.id && a.caracteristica_id === id,
          ),
      )
      .map((id) => ({
        product_id: p.id,
        characteristic: id,
        reason: 'MISSING_PRODUCT_IDENTIFYING_CHARACTERISTIC',
      }));
  });
const integrityFindings = [];
for (const [label, rows, key] of [
  ['product_id', audit.products, 'id'],
  ['product_sku', audit.products, 'sku_base'],
  ['variant_id', audit.variants, 'id'],
  ['variant_sku', audit.variants, 'sku'],
  ['sku_identity', audit.identities, 'sku'],
]) {
  if (new Set(rows.map((r) => r[key])).size !== rows.length)
    integrityFindings.push(label + ':DUPLICATE');
}
for (const v of audit.variants) {
  if (
    !audit.products.some((p) => p.id === v.product_id && p.tiene_variantes) ||
    !audit.identities.some(
      (s) => s.variant_id === v.id && s.sku === v.sku && s.product_id === null,
    )
  )
    integrityFindings.push(v.sku + ':OWNER_MISMATCH');
  const key = Object.fromEntries(
    audit.variant_attributes
      .filter((a) => a.variant_id === v.id && a.es_identificador)
      .map((a) => [
        a.caracteristica_id,
        a.valor_id ? { valor_id: a.valor_id } : { valor: a.valor },
      ]),
  );
  if (
    JSON.stringify(Object.entries(key).sort()) !==
    JSON.stringify(Object.entries(v.identifying_key).sort())
  )
    integrityFindings.push(v.sku + ':KEY_MISMATCH');
}
const missingObjects = [...audit.product_images, ...audit.variant_images]
  .filter(
    (i) =>
      !i.url.startsWith(publicBase) ||
      !audit.storage.some((o) => publicBase + o.name === i.url),
  )
  .map((i) => ({ image_id: i.id, url: i.url }));
const compare = (kind, expected, actual, fields) => {
  for (const f of fields)
    if (JSON.stringify(expected[f]) !== JSON.stringify(actual?.[f]))
      diff.push({
        kind,
        id: expected.id,
        field: f,
        expected: expected[f],
        actual: actual?.[f],
      });
};
for (const p of manifest.productos) {
  compare(
    'product',
    p,
    audit.products.find((x) => x.id === p.id),
    [
      'nombre',
      'descripcion',
      'categoria_id',
      'tipo_producto_id',
      'marca_id',
      'sku_base',
      'slug',
      'tiene_variantes',
      'estado',
    ],
  );
  for (const v of p.variantes ?? []) {
    const actual = audit.variants.find((x) => x.id === v.id);
    compare('variant', v, actual, ['product_id', 'sku', 'estado']);
    if (
      JSON.stringify(Object.entries(v.identifying_key).sort()) !==
      JSON.stringify(Object.entries(actual?.identifying_key ?? {}).sort())
    )
      diff.push({ kind: 'variant', id: v.id, field: 'identifying_key' });
    compare(
      'variant_image',
      { id: v.image_id, url: v.url, variant_id: v.id },
      audit.variant_images.find((x) => x.id === v.image_id),
      ['url', 'variant_id'],
    );
    for (const expected of v.atributos_identificadores ?? []) {
      const actual = audit.variant_attributes.find(
        (a) =>
          a.variant_id === v.id &&
          a.caracteristica_id === expected.caracteristica_id,
      );
      compare(
        'variant_attribute',
        {
          id: actual?.id,
          valor_id: expected.value_id,
          valor: expected.valor,
          es_identificador: expected.es_identificador,
        },
        actual,
        ['valor_id', 'valor', 'es_identificador'],
      );
    }
  }
  if (!p.tiene_variantes) {
    compare(
      'product_image',
      {
        id: p.product_image_id,
        product_id: p.id,
        url: p.presentaciones[0].url_publica,
      },
      audit.product_images.find((i) => i.id === p.product_image_id),
      ['product_id', 'url'],
    );
    for (const expected of p.atributos_simple ?? []) {
      const characteristic = manifest.taxonomy.characteristics[expected.name];
      const actual = audit.product_attributes.find(
        (a) => a.product_id === p.id && a.caracteristica_id === characteristic,
      );
      compare(
        'product_attribute',
        { id: actual?.id, valor_id: expected.value_id, valor: expected.valor },
        actual,
        ['valor_id', 'valor'],
      );
    }
  }
}
emit(
  'activation-blockers.csv',
  csv([
    [
      'producto_id',
      'sku',
      'presentacion',
      'estado',
      'perfil',
      'pricing_producto',
      'inventory_sku',
      'imagen_producto',
      'imagen_sku',
      'atributos',
      'identificadores_padre',
      'resultado',
    ],
    ...sellable.map((s) => {
      const v = audit.variants.find((v) => v.id === s.variant_id);
      const p = audit.products.find(
        (p) => p.id === (v?.product_id ?? s.product_id),
      );
      return [
        p.id,
        s.sku,
        v ? 'VARIANTE' : 'SIMPLE',
        v?.estado ?? p.estado,
        'PENDING_SEMANTIC_DECISION_AND_LOAD',
        'NO_REGISTRADA',
        'NO_REGISTRADA',
        audit.product_images.some((i) => i.product_id === p.id)
          ? 'EXISTE'
          : 'FALTA',
        v
          ? audit.variant_images.some(
              (i) => i.variant_id === v.id && i.url.startsWith(publicBase),
            )
            ? 'EXISTE'
            : 'PLACEHOLDER'
          : 'VER_PRODUCTO',
        attributeFindings
          .filter((f) => f.sku === s.sku)
          .map((f) => f.reason)
          .join('|') || 'REFERENCIAS_VALIDAS',
        identifyingFindings.some((f) => f.product_id === p.id)
          ? 'FALTAN'
          : 'OK',
        'BLOCKED_ACTIVATION',
      ];
    }),
  ]),
);
emit(
  'evidence/reconciliation.json',
  JSON.stringify(
    {
      audited_at: audit.audited_at,
      original_products: [...ids],
      additional_products: audit.products
        .filter((p) => !ids.has(p.id))
        .map((p) => ({ id: p.id, sku: p.sku_base })),
      sellable_skus: sellable.length,
      non_sellable_bases: audit.identities.length - sellable.length,
      manifest_differences: diff,
      missing_master_references: missingReferences,
      attribute_findings: attributeFindings,
      identifying_findings: identifyingFindings,
      integrity_findings: integrityFindings,
      missing_storage_references: missingObjects,
      no_profiles: (audit.profiles ?? []).length === 0,
      no_preparations: (audit.activation_checks ?? []).length === 0,
    },
    null,
    2,
  ),
);
reviewData();
const files = [
  'METODOLOGIA-PERFILES.md',
  'RESPUESTA-AUDITORIA.md',
  'evidence/normative-followup.json',
  'evidence/audit-followup-preflight.json',
  'review-data.mjs',
  'sources/model-color-review.json',
  'reference-image-review.json',
  'reference-image-review.csv',
  'template-reuse.csv',
  'attribute-review.json',
  'evidence/physical-quality-review.json',
  'evidence/storage-image-http.json',
  'evidence/jd9558-image-correspondence.json',
  'evidence/audit-followup-readonly.json',
  'prepare-profiles.mjs',
  'extract-profiles.py',
  'sources/physical-profiles-academic.xlsx',
  'sources/physical-profiles-extracted.json',
  'evidence/profiles-readonly.json',
  'evidence/profiles-preflight.json',
  'profile-manifest.json',
  'profiles-proposed.csv',
  'profiles-preflight.sql',
  'profiles-apply-proposed.sql',
  'profiles-postcheck.sql',
  'image-map.json',
  'cover-map.json',
  'images-preflight.sql',
  'images-apply-proposed.sql',
  'images-postcheck.sql',
  'covers-preflight.sql',
  'covers-apply-proposed.sql',
  'covers-postcheck.sql',
  'physical-profiles.csv',
  'physical-input-template.csv',
  'activation-blockers.csv',
  'audit-readonly.sql',
  'prepare.mjs',
  'isolated.test.mjs',
  '../test/data002.e2e-spec.ts',
  '../src/catalog-master.client.spec.ts',
  'README.md',
  'migrations-preflight.sql',
  'migrations-postcheck.sql',
  'evidence/image-preflight.json',
  'evidence/cover-preflight.json',
  'evidence/historical-source-hashes.json',
  'evidence/supabase-readonly.json',
  'evidence/normative-sources.json',
  'evidence/reconciliation.json',
  '../migrations/0002_create_sku_barcodes.sql',
  '../migrations/0003_product_publication_history.sql',
];
emit(
  'SHA256SUMS',
  files
    .map(
      (f) =>
        `${
          f.endsWith('.xlsx')
            ? createHash('sha256')
                .update(readFileSync(resolve(root, f)))
                .digest('hex')
            : sha(read(f))
        }  ${f}`,
    )
    .join('\n'),
);
console.log(
  JSON.stringify({
    images: images.length,
    pitch: 1,
    covers: covers.length,
    pending_cover_proposals: blockedCovers.length,
    sellable: sellable.length,
    manifest_differences: diff.length,
    missing_master_references: missingReferences.length,
    attribute_findings: attributeFindings.length,
  }),
);
