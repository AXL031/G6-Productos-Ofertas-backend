import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { fields, profileSql, resolveProfiles } from './prepare-profiles.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const audit = JSON.parse(read('evidence/supabase-readonly.json'));
const map = JSON.parse(read('image-map.json'));
const covers = JSON.parse(read('cover-map.json')).covers;
const profileManifest = JSON.parse(read('profile-manifest.json'));
const profileSource = JSON.parse(
  read('sources/physical-profiles-extracted.json'),
);
const profileAudit = JSON.parse(read('evidence/profiles-readonly.json'));
const pgBin =
  process.env.DATA002_PG_BIN ??
  (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/16/bin' : '');
const native = existsSync(
  join(pgBin, process.platform === 'win32' ? 'initdb.exe' : 'initdb'),
);
const container = 'catalog-data002-' + process.pid + '-' + Date.now();
let directory,
  port,
  started = false,
  number = 0,
  database = 'postgres';
function command(exe, args, input) {
  const result = spawnSync(exe, args, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    ...(exe.endsWith('pg_ctl') ? { stdio: 'ignore' } : {}),
  });
  if (result.error || result.status !== 0)
    throw Error(`${exe}: ${result.error?.message ?? result.stderr}`);
  return result.stdout?.trim() ?? '';
}
function sql(source, db = database) {
  const args = [
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    'VERBOSITY=terse',
    '-At',
    '-U',
    'postgres',
    '-d',
    db,
  ];
  return native
    ? command(
        join(pgBin, 'psql'),
        ['-h', '127.0.0.1', '-p', String(port), ...args],
        source,
      )
    : command('docker', ['exec', '-i', container, 'psql', ...args], source);
}
function owner(source) {
  // Aprobación semántica simulada solo en el PostgreSQL desechable.
  return sql(
    "SET catalog.data002_physical_semantics='ACADEMIC_LOGISTIC_EXCEPTION_APPROVED'; SET ROLE po_catalog_owner;\n" +
      source,
  );
}
const scalar = (query) => sql(query).split(/\r?\n/).at(-1);
const canonical = `SELECT jsonb_build_object('p',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM catalog.products p),
  'v',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM catalog.variants v),'s',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM catalog.sku_identity s),
  'f',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM catalog.sku_physical_profiles f),'a',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM catalog.activation_checks a),
  'foreign',(SELECT jsonb_agg(to_jsonb(f)) FROM foreign_context.sentinel f),'storage',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM storage.objects o))`;
const fullImages = `SELECT jsonb_build_object('p',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM catalog.product_images i),'v',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM catalog.variant_images i))`;
before(async () => {
  if (native) {
    directory = mkdtempSync(join(tmpdir(), 'catalog-data002-'));
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    await new Promise((r) => server.close(r));
    command(join(pgBin, 'initdb'), [
      '-D',
      join(directory, 'data'),
      '-A',
      'trust',
      '-U',
      'postgres',
      '--no-locale',
      '--encoding=UTF8',
    ]);
    command(join(pgBin, 'pg_ctl'), [
      '-D',
      join(directory, 'data'),
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port}`,
      '-w',
      'start',
    ]);
  } else {
    command('docker', [
      'run',
      '--detach',
      '--name',
      container,
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      'postgres:17',
    ]);
    started = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (
        spawnSync(
          'docker',
          [
            'exec',
            container,
            'pg_isready',
            '-h',
            '127.0.0.1',
            '-U',
            'postgres',
          ],
          { windowsHide: true },
        ).status === 0
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw Error('DATA002_POSTGRES_FINAL_TCP_NOT_READY');
  }
  started = true;
  sql('CREATE DATABASE data002_template;');
  database = 'data002_template';
  sql(`CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app NOLOGIN;
    CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;
    CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,metadata jsonb);
    GRANT USAGE ON SCHEMA storage TO po_catalog_owner; GRANT SELECT ON ALL TABLES IN SCHEMA storage TO po_catalog_owner;
    CREATE SCHEMA foreign_context; CREATE TABLE foreign_context.sentinel(value text); INSERT INTO foreign_context.sentinel VALUES('unchanged');`);
  owner(read('../test/fixtures/0001_create_catalog.sql'));
  let fixture = 'BEGIN; SET ROLE po_catalog_owner;\n';
  for (const [key, table] of [
    ['products', 'products'],
    ['variants', 'variants'],
    ['product_images', 'product_images'],
    ['variant_images', 'variant_images'],
    ['product_attributes', 'product_attribute_values'],
    ['variant_attributes', 'variant_attribute_values'],
    ['identifying_characteristics', 'product_identifying_characteristics'],
  ]) {
    for (const row of audit[key]) {
      const columns = Object.keys(row);
      const values = columns.map((c) =>
        c === 'valor' || (row[c] !== null && typeof row[c] === 'object')
          ? '$json$' + JSON.stringify(row[c]) + '$json$::jsonb'
          : row[c] === null
            ? 'NULL'
            : typeof row[c] === 'string'
              ? "'" + row[c].replaceAll("'", "''") + "'"
              : String(row[c]),
      );
      fixture += `INSERT INTO catalog.${table}(${columns.join(',')}) VALUES(${values.join(',')});\n`;
    }
  }
  fixture += 'COMMIT;';
  owner(fixture);
  // sku_identity se deriva por triggers; IDs reales se restauran solo en fixture desechable para contrastar perfiles.
  sql(`ALTER TABLE catalog.sku_identity DISABLE TRIGGER USER; DELETE FROM catalog.sku_identity;
    INSERT INTO catalog.sku_identity SELECT * FROM jsonb_populate_recordset(NULL::catalog.sku_identity,$json$${JSON.stringify(audit.identities)}$json$::jsonb);
    ALTER TABLE catalog.sku_identity ENABLE TRIGGER USER;
    INSERT INTO storage.buckets VALUES('catalog-products',true);
    INSERT INTO storage.objects SELECT id,'catalog-products',name,metadata FROM jsonb_to_recordset($json$${JSON.stringify(audit.storage)}$json$::jsonb) AS r(id uuid,name text,metadata jsonb);`);
  database = 'postgres';
});
beforeEach(() => {
  database = 'postgres';
  const next = 'data002_case_' + ++number;
  sql('CREATE DATABASE ' + next + ' TEMPLATE data002_template;');
  database = next;
});
after(() => {
  if (started) {
    if (native)
      command(join(pgBin, 'pg_ctl'), [
        '-D',
        join(directory, 'data'),
        '-m',
        'immediate',
        '-w',
        'stop',
      ]);
    else command('docker', ['rm', '-f', container]);
  }
  if (
    directory &&
    resolve(directory).startsWith(resolve(tmpdir()) + '\\') &&
    dirname(directory) === resolve(tmpdir())
  )
    rmSync(directory, { recursive: true, force: true });
});
test('preflight detecta exactamente seis placeholders y Pitch faltante', () => {
  const result = owner(read('images-preflight.sql'));
  assert.equal(result.split('READY').length - 1, 6);
  assert.equal(result.split(/\r?\n/).at(-1), 't');
  assert.equal(scalar('SELECT count(*) FROM catalog.product_images'), '3');
});
test('corrige siete vínculos, genera UUID estándar y reintenta sin duplicados', () => {
  const before = sql(canonical);
  owner(read('images-apply-proposed.sql'));
  assert.equal(sql(canonical), before);
  for (const i of map.images)
    assert.equal(
      scalar(`SELECT url FROM catalog.variant_images WHERE id='${i.image_id}'`),
      i.url,
    );
  assert.equal(
    scalar(
      `SELECT count(*) FROM catalog.product_images WHERE product_id='${map.pitch.product_id}' AND principal AND posicion=0`,
    ),
    '1',
  );
  const first = sql(fullImages);
  owner(read('images-apply-proposed.sql'));
  assert.equal(sql(fullImages), first);
  const postcheck = owner(read('images-postcheck.sql')).split(/\r?\n/);
  for (const i of map.images) assert.ok(postcheck.includes(i.sku + '|t'));
  assert.ok(postcheck.includes('t'));
});
for (const [label, mutation] of [
  [
    'URL conflictiva',
    `UPDATE catalog.variant_images SET url='https://example.org/conflict.jpg' WHERE id='${map.images[5].image_id}'`,
  ],
  [
    'imagen asociada a otro SKU',
    `BEGIN; UPDATE catalog.variant_images SET variant_id=CASE WHEN id='${map.images[1].image_id}' THEN '${map.images[5].variant_id}'::uuid ELSE '${map.images[1].variant_id}'::uuid END WHERE id IN ('${map.images[1].image_id}','${map.images[5].image_id}'); COMMIT;`,
  ],
  [
    'objeto inexistente',
    `DELETE FROM storage.objects WHERE id='${map.images[5].storage_id}'`,
  ],
  [
    'archivo reemplazado',
    `UPDATE storage.objects SET metadata=jsonb_set(metadata,'{eTag}','"changed"') WHERE id='${map.images[5].storage_id}'`,
  ],
  [
    'Pitch con imagen divergente',
    `INSERT INTO catalog.product_images(product_id,url) VALUES('${map.pitch.product_id}','https://example.org/other.jpg')`,
  ],
])
  test(label + ': revierte incluso las sustituciones anteriores', () => {
    sql(mutation);
    const before = sql(fullImages);
    assert.throws(() => owner(read('images-apply-proposed.sql')), /DATA002_/);
    assert.equal(sql(fullImages), before);
  });
test('portadas revisadas, conservación de existentes, reintento y cuatro fuera de propuesta', () => {
  const coverMap = JSON.parse(read('cover-map.json'));
  assert.equal(covers.length, 12);
  assert.ok(covers.some((c) => c.sku === 'ADI-RUNX-JD9558-BASE'));
  assert.equal(coverMap.pending_proposal.length, 4);
  assert.deepEqual(coverMap.image_conflicts, []);
  const before = sql(canonical);
  const originalImages = scalar(
    'SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM catalog.product_images i',
  );
  owner(read('covers-apply-proposed.sql'));
  assert.equal(
    scalar('SELECT count(*) FROM catalog.product_images'),
    String(3 + covers.length),
  );
  assert.equal(sql(canonical), before);
  const postcheck = owner(read('covers-postcheck.sql')).split(/\r?\n/);
  for (const c of covers) assert.ok(postcheck.includes(c.sku + '|t'));
  const first = sql(fullImages);
  owner(read('covers-apply-proposed.sql'));
  assert.equal(sql(fullImages), first);
  assert.equal(
    scalar(
      `SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM catalog.product_images i WHERE product_id NOT IN (${covers.map((c) => `'${c.product_id}'`).join(',')})`,
    ),
    originalImages,
  );
});
test('portada existente válida se conserva; fuente incorrecta aborta el paquete', () => {
  const c = covers[0];
  owner(
    `INSERT INTO catalog.product_images(product_id,url,principal,posicion) VALUES('${c.product_id}','${c.url}',true,0)`,
  );
  owner(read('covers-apply-proposed.sql'));
  assert.equal(
    scalar(
      `SELECT count(*) FROM catalog.product_images WHERE product_id='${c.product_id}'`,
    ),
    '1',
  );
  sql(
    `UPDATE catalog.variant_images SET url='https://example.org/wrong.jpg' WHERE id='${covers.at(-1).source_image_id}'`,
  );
  const before = sql(fullImages);
  assert.throws(
    () => owner(read('covers-apply-proposed.sql')),
    /DATA002_COVER_SOURCE_CONFLICT/,
  );
  assert.equal(sql(fullImages), before);
});
test('0002: unicidad incluso retirada, identidad inmutable y solo SKU vendible', () => {
  owner(read('../migrations/0002_create_sku_barcodes.sql'));
  const simple = audit.identities.find((s) => s.sku === map.pitch.sku);
  const base = audit.identities.find((s) => s.sku === covers[0].sku);
  owner(
    `INSERT INTO catalog.sku_barcodes(codigo_barras,sku_identity_id,created_by) VALUES('0000123','${simple.id}','isolated');`,
  );
  owner(
    `UPDATE catalog.sku_barcodes SET retired_at=clock_timestamp(),retired_by='isolated';`,
  );
  assert.throws(
    () =>
      owner(
        `INSERT INTO catalog.sku_barcodes(codigo_barras,sku_identity_id,created_by) VALUES('0000123','${simple.id}','isolated')`,
      ),
    /duplicate key/,
  );
  assert.throws(
    () =>
      owner(
        `INSERT INTO catalog.sku_barcodes(codigo_barras,sku_identity_id,created_by) VALUES('base','${base.id}','isolated')`,
      ),
    /Require sellable SKU/,
  );
  assert.throws(
    () => owner("UPDATE catalog.sku_barcodes SET codigo_barras='changed'"),
    /immutable/,
  );
  assert.throws(
    () => owner('DELETE FROM catalog.sku_barcodes'),
    /cannot be deleted/,
  );
  assert.equal(scalar('SELECT count(*) FROM catalog.activation_checks'), '0');
});
test('0003: histórico NULL, nuevo false, activación/rollback atómicos y true irreversible', () => {
  owner(read('../migrations/0003_product_publication_history.sql'));
  assert.equal(
    scalar(
      'SELECT count(*) FROM catalog.products WHERE publicado_alguna_vez IS NULL',
    ),
    '20',
  );
  owner(
    "INSERT INTO catalog.products(nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes,publicado_alguna_vez) VALUES('isolated','isolated','c','t','b','isolated-new','isolated-new',false,true)",
  );
  assert.equal(
    scalar(
      "SELECT publicado_alguna_vez FROM catalog.products WHERE sku_base='isolated-new'",
    ),
    'f',
  );
  assert.throws(
    () =>
      owner(
        "UPDATE catalog.products SET publicado_alguna_vez=false WHERE sku_base='NIK-PITCH-05'",
      ),
    /PUBLICATION_HISTORY_IMMUTABLE/,
  );
  assert.throws(
    () =>
      owner(
        "BEGIN; UPDATE catalog.products SET estado='ACTIVO' WHERE sku_base='isolated-new'; SET CONSTRAINTS ALL IMMEDIATE; COMMIT",
      ),
    /requiere/,
  );
  assert.equal(
    scalar(
      "SELECT publicado_alguna_vez FROM catalog.products WHERE sku_base='isolated-new'",
    ),
    'f',
  );
  // Fixture explícito solo desechable: imagen, perfil e inicializaciones necesarias.
  owner(`BEGIN;
    INSERT INTO catalog.product_images(product_id,url) SELECT id,'https://example.org/fixture.jpg' FROM catalog.products WHERE sku_base='isolated-new';
    INSERT INTO catalog.sku_physical_profiles(sku_identity_id,peso_kg,largo_cm,ancho_cm,alto_cm) SELECT id,1,1,1,1 FROM catalog.sku_identity WHERE sku='isolated-new';
    INSERT INTO catalog.activation_checks(product_id,sku,dependency,operation_id,correlation_id,request_payload,state,result_payload,result_message_id)
      SELECT p.id,p.sku_base,d,gen_random_uuid(),gen_random_uuid(),'{}','COMPLETED','{}',gen_random_uuid() FROM catalog.products p CROSS JOIN (VALUES('PRICING'),('INVENTORY')) dep(d) WHERE sku_base='isolated-new';
    UPDATE catalog.products SET estado='ACTIVO' WHERE sku_base='isolated-new'; COMMIT;`);
  assert.equal(
    scalar(
      "SELECT publicado_alguna_vez FROM catalog.products WHERE sku_base='isolated-new'",
    ),
    't',
  );
  owner(
    "UPDATE catalog.products SET estado='INACTIVO' WHERE sku_base='isolated-new'",
  );
  assert.throws(
    () =>
      owner(
        "UPDATE catalog.products SET publicado_alguna_vez=false WHERE sku_base='isolated-new'",
      ),
    /PUBLICATION_HISTORY_IMMUTABLE/,
  );
});
test('perfil físico: rechaza padre no vendible y valores no positivos', () => {
  const base = audit.identities.find((s) => s.sku === covers[0].sku);
  const simple = audit.identities.find((s) => s.sku === map.pitch.sku);
  assert.throws(
    () =>
      owner(
        `INSERT INTO catalog.sku_physical_profiles(sku_identity_id,peso_kg) VALUES('${base.id}',1)`,
      ),
    /perfil fisico/,
  );
  for (const value of ['0', '-1', "'NaN'", "'Infinity'"])
    assert.throws(
      () =>
        owner(
          `INSERT INTO catalog.sku_physical_profiles(sku_identity_id,peso_kg) VALUES('${simple.id}',${value})`,
        ),
      /check constraint/,
    );
  assert.equal(
    scalar('SELECT count(*) FROM catalog.sku_physical_profiles'),
    '0',
  );
});
test('ambos paquetes conservan 20/51/71, cero perfiles/preparaciones y schemas ajenos', () => {
  const before = sql(canonical);
  owner(read('images-apply-proposed.sql'));
  owner(read('covers-apply-proposed.sql'));
  assert.equal(sql(canonical), before);
  assert.equal(scalar('SELECT count(*) FROM catalog.products'), '20');
  assert.equal(scalar('SELECT count(*) FROM catalog.variants'), '51');
  assert.equal(scalar('SELECT count(*) FROM catalog.sku_identity'), '71');
  assert.equal(
    scalar('SELECT count(*) FROM catalog.product_images'),
    String(4 + covers.length),
  );
});

test('perfiles académicos: 55 READY y asignación exacta de 51 variantes + 4 simples', () => {
  assert.throws(
    () =>
      sql('SET ROLE po_catalog_owner;\n' + read('profiles-apply-proposed.sql')),
    /DATA002_PHYSICAL_SEMANTICS_NOT_APPROVED/,
  );
  const result = owner(read('profiles-preflight.sql')).split(/\r?\n/);
  assert.equal(result.filter((r) => r.endsWith('|READY')).length, 55);
  assert.equal(
    profileManifest.profiles.filter((p) => p.tipo_unidad === 'VARIANTE').length,
    51,
  );
  assert.equal(
    profileManifest.profiles.filter((p) => p.tipo_unidad === 'PRODUCTO_SIMPLE')
      .length,
    4,
  );
  assert.equal(
    scalar('SELECT count(*) FROM catalog.sku_physical_profiles'),
    '0',
  );
});
test('carga exacta de las 220 medidas, UUID de perfil estándar y reintento sin cambios', () => {
  const before = JSON.parse(sql(canonical));
  delete before.f;
  const imagesBefore = sql(fullImages);
  owner(read('profiles-apply-proposed.sql'));
  const after = JSON.parse(sql(canonical));
  delete after.f;
  assert.deepEqual(after, before);
  assert.equal(sql(fullImages), imagesBefore);
  const actual = JSON.parse(
    scalar(
      `SELECT jsonb_agg(jsonb_build_object('sku_identity_id',f.sku_identity_id,${fields.map((f) => "'" + f + "',f." + f + '::text').join(',')}) ORDER BY f.sku_identity_id) FROM catalog.sku_physical_profiles f`,
    ),
  );
  const expected = profileManifest.profiles
    .map((p) =>
      Object.fromEntries(['sku_identity_id', ...fields].map((f) => [f, p[f]])),
    )
    .sort((a, b) => a.sku_identity_id.localeCompare(b.sku_identity_id));
  assert.deepEqual(actual, expected);
  const first = scalar(
    'SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM catalog.sku_physical_profiles f',
  );
  owner(read('profiles-apply-proposed.sql'));
  assert.equal(
    scalar(
      'SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM catalog.sku_physical_profiles f',
    ),
    first,
  );
  assert.equal(
    owner(read('profiles-preflight.sql')).split('ALREADY_APPLIED').length - 1,
    55,
  );
  assert.equal(
    scalar(
      'SELECT count(*) FROM catalog.sku_physical_profiles f JOIN catalog.sku_identity s ON s.id=f.sku_identity_id JOIN catalog.products p ON p.id=s.product_id WHERE p.tiene_variantes',
    ),
    '0',
  );
  const postcheck = owner(read('profiles-postcheck.sql')).split(/\r?\n/);
  assert.equal(postcheck.filter((r) => r.endsWith('|t')).length, 55);
  assert.equal(postcheck.at(-1), '0');
});
test('perfil ya existente idéntico conserva su UUID y timestamps', () => {
  const p = profileManifest.profiles[0];
  owner(
    `INSERT INTO catalog.sku_physical_profiles(sku_identity_id,${fields.join(',')}) VALUES('${p.sku_identity_id}',${fields.map((f) => p[f]).join(',')})`,
  );
  const before = scalar(
    `SELECT to_jsonb(f) FROM catalog.sku_physical_profiles f WHERE sku_identity_id='${p.sku_identity_id}'`,
  );
  owner(read('profiles-apply-proposed.sql'));
  assert.equal(
    scalar(
      `SELECT to_jsonb(f) FROM catalog.sku_physical_profiles f WHERE sku_identity_id='${p.sku_identity_id}'`,
    ),
    before,
  );
  assert.equal(
    scalar('SELECT count(*) FROM catalog.sku_physical_profiles'),
    '55',
  );
});
test('conflicto con perfil parcial o divergente revierte el lote completo', () => {
  const p = profileManifest.profiles.at(-1);
  owner(
    `INSERT INTO catalog.sku_physical_profiles(sku_identity_id,peso_kg) VALUES('${p.sku_identity_id}',9)`,
  );
  const before = sql(canonical);
  assert.throws(
    () => owner(read('profiles-apply-proposed.sql')),
    /DATA002_PROFILE_CONFLICT/,
  );
  assert.equal(sql(canonical), before);
  assert.equal(
    scalar('SELECT count(*) FROM catalog.sku_physical_profiles'),
    '1',
  );
});
for (const [label, change] of [
  ['SKU desconocido', (p) => ({ ...p, sku: 'DATA002-NO-EXISTE' })],
  [
    'UUID de identidad diferente',
    (p) => ({ ...p, sku_identity_id: '00000000-0000-4000-8000-000000000000' }),
  ],
  [
    'asignación de padre no vendible',
    (p) => {
      const s = audit.identities.find((s) => s.sku === covers[0].sku);
      return {
        ...p,
        sku: s.sku,
        sku_identity_id: s.id,
        product_id: s.product_id,
        variant_id: null,
        sku_base: s.sku,
        tipo_unidad: 'PRODUCTO_SIMPLE',
      };
    },
  ],
  ['medida nula', (p) => ({ ...p, peso_kg: null })],
  ['medida cero', (p) => ({ ...p, largo_cm: '0' })],
  ['medida negativa', (p) => ({ ...p, ancho_cm: '-1' })],
  ['medida no finita', (p) => ({ ...p, alto_cm: 'NaN' })],
])
  test(label + ': SQL aborta sin insertar perfiles parciales', () => {
    const profiles = structuredClone(profileManifest.profiles);
    profiles[profiles.length - 1] = change(profiles.at(-1));
    const before = sql(canonical);
    assert.throws(() => owner(profileSql(profiles).apply), /DATA002_/);
    assert.equal(sql(canonical), before);
  });
test('fuente: rechaza duplicados, filas incompletas, SKU ajenos y tipo erróneo antes de generar SQL', () => {
  const images = JSON.parse(read('reference-image-review.json'));
  assert.equal(images.length, 55);
  assert.equal(
    images.filter((r) =>
      r.visual_review.startsWith('ASOCIACION_POR_NOMBRE_Y_SKU'),
    ).length,
    52,
  );
  const runx = images.filter((r) => r.sku.startsWith('ADI-RUNX-'));
  const proof = JSON.parse(read('evidence/jd9558-image-correspondence.json'));
  assert.equal(runx.length, 3);
  assert.equal(proof.official_image.status, 200);
  assert.equal(proof.stored_image.status, 200);
  assert.equal(proof.official_image.sha256, proof.stored_image.sha256);
  for (const r of runx) {
    assert.equal(r.catalog_color, 'Negro');
    assert.equal(r.reference_color, 'Black / White / Black');
    assert.equal(r.reference_url, proof.official_product_url);
    assert.equal(r.image_url, proof.stored_image.url);
    assert.equal(r.image_sha256, proof.official_image.sha256);
    assert.equal(
      r.visual_review,
      'IMAGEN_IDENTICA_A_FUENTE_OFICIAL_POR_SHA256',
    );
  }
  assert.ok(images.every((r) => r.http_status === 200));
  const review = JSON.parse(read('evidence/physical-quality-review.json'));
  assert.deepEqual(
    [
      review.distinct_templates,
      review.skus_sharing_template,
      review.estimates,
      review.published_not_homologated,
      review.packaged_presentations,
      review.unpackaged_balls,
    ],
    [27, 39, 213, 7, 51, 4],
  );
  const attributes = JSON.parse(read('attribute-review.json'));
  assert.equal(attributes.list_values_with_json_null.length, 12);
  assert.ok(
    attributes.list_values_with_json_null.every(
      (a) => a.value_active && a.value_belongs && !a.normalization_required,
    ),
  );
  assert.equal(attributes.missing_product_identifying_associations.length, 8);
  assert.equal(attributes.missing_pitch_attributes.length, 2);
  assert.equal(
    profileManifest.profiles.find((p) => p.sku === 'ADI-ENT26-BLA-S')
      .modelo_ref,
    'JZ2508',
  );
  assert.equal(
    profileManifest.profiles.find((p) => p.sku === 'NIK-PITCH-05').modelo_ref,
    'FZ2636-101',
  );
  for (const mutation of [
    (s) => s.profiles.pop(),
    (s) => {
      s.profiles[1].sku = s.profiles[0].sku;
    },
    (s) => {
      s.profiles[0].peso_kg = '';
    },
    (s) => {
      s.profiles[0].alto_cm = 'Infinity';
    },
    (s) => {
      s.profiles[0].sku = 'UNKNOWN';
    },
    (s) => {
      s.profiles[0].tipo_unidad = 'PRODUCTO_SIMPLE';
    },
  ]) {
    const source = structuredClone(profileSource);
    mutation(source);
    assert.throws(() => resolveProfiles(source, profileAudit), /DATA002_/);
  }
});
