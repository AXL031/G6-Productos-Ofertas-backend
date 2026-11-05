"""Validate the additionally authorized INSERTs in a disposable local cluster only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
PG = Path(os.environ['DATA002_PG_BIN']).resolve()
snapshot = json.loads((ROOT / 'after-profiles-snapshot.json').read_text(encoding='utf-8'))[0]['snapshot']
audit = json.loads(subprocess.check_output(['git', 'show', '5abfffc9b86306df87d19695817aa678588e0341:apps/catalog-svc/data002/evidence/supabase-readonly.json'], cwd=REPO))
proposal = json.loads((ROOT / 'additional-scope-proposal.json').read_text(encoding='utf-8'))
covers = (ROOT / 'additional-covers-apply-proposed.sql').read_text(encoding='utf-8')
attrs = (ROOT / 'additional-attributes-apply.sql').read_text(encoding='utf-8')
directory = Path(tempfile.mkdtemp(prefix='data002-extra-')).resolve()
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env.update(PGHOST='127.0.0.1', PGPORT=str(port), PGUSER='postgres', PGDATABASE='postgres', PGSSLMODE='disable', PGCONNECT_TIMEOUT='5')
flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def command(name, args, source=None, quiet=False):
    result = subprocess.run([str(PG / (name + ('.exe' if os.name == 'nt' else ''))), *args], input=source,
                            env=env, encoding='utf-8', stdout=subprocess.DEVNULL if quiet else subprocess.PIPE,
                            stderr=subprocess.DEVNULL if quiet else subprocess.PIPE, timeout=120, creationflags=flags)
    if result.returncode:
        raise RuntimeError(result.stderr or name + ' failed')
    return (result.stdout or '').strip()


def sql(source, db='postgres', owner=False):
    return command('psql', ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', db],
                   ('SET ROLE po_catalog_owner;\n' if owner else '') + source)


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def insert(table, rows):
    result = []
    for row in rows:
        values = [literal(json.dumps(v)) + '::jsonb' if k == 'valor' or isinstance(v, (dict, list))
                  else 'NULL' if v is None else literal(v) for k, v in row.items()]
        result.append(f"INSERT INTO catalog.{table}({','.join(row)}) VALUES({','.join(values)});")
    return '\n'.join(result)


tables = ['products', 'variants', 'sku_identity', 'product_images', 'variant_images', 'sku_physical_profiles',
          'product_attribute_values', 'variant_attribute_values', 'product_identifying_characteristics',
          'activation_checks', 'master_barriers', 'outbox', 'inbox']
state_query = "SELECT jsonb_build_object(" + ','.join(
    literal(t) + f",(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM catalog.{t} t)" for t in tables) + ');'


def state(db):
    return json.loads(sql(state_query, db))


def expect_error(source, db, error, owner=True):
    try:
        sql(source, db, owner)
    except RuntimeError as exc:
        assert error in str(exc), str(exc)
    else:
        raise AssertionError('Expected ' + error)


results = []
started = False
try:
    command('initdb', ['-D', str(directory / 'data'), '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8'])
    command('pg_ctl', ['-D', str(directory / 'data'), '-l', str(directory / 'postgres.log'), '-o', f'-h 127.0.0.1 -p {port}', '-w', 'start'], quiet=True)
    started = True
    sql('CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app NOLOGIN; CREATE DATABASE extra_template;')
    sql('CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean); CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,metadata jsonb); GRANT USAGE ON SCHEMA storage TO po_catalog_owner; GRANT SELECT ON ALL TABLES IN SCHEMA storage TO po_catalog_owner;', 'extra_template')
    schema = subprocess.check_output(['git', 'show', '5abfffc9b86306df87d19695817aa678588e0341:apps/catalog-svc/test/fixtures/0001_create_catalog.sql'], cwd=REPO).decode('utf-8')
    sql(schema, 'extra_template', True)
    fixture = 'BEGIN;\n' + '\n'.join(insert(t, snapshot[t]) for t in ['products', 'variants', 'product_images', 'variant_images', 'product_attribute_values', 'variant_attribute_values', 'product_identifying_characteristics']) + '\nCOMMIT;'
    sql(fixture, 'extra_template', True)
    # Only in this disposable fixture: restore production identity IDs after trigger generation.
    sql('ALTER TABLE catalog.sku_identity DISABLE TRIGGER USER; DELETE FROM catalog.sku_identity;\n' + insert('sku_identity', snapshot['sku_identity']) + '\nALTER TABLE catalog.sku_identity ENABLE TRIGGER USER;', 'extra_template')
    sql(insert('sku_physical_profiles', snapshot['sku_physical_profiles']), 'extra_template', True)
    storage = 'INSERT INTO storage.buckets VALUES(\'catalog-products\',true);\n'
    for obj in audit['storage']:
        storage += 'INSERT INTO storage.objects VALUES(' + literal(obj['id']) + ", 'catalog-products'," + literal(obj['name']) + ',' + literal(json.dumps(obj['metadata'])) + '::jsonb);\n'
    sql(storage, 'extra_template')

    sql('CREATE DATABASE extra_success TEMPLATE extra_template;')
    before = state('extra_success')
    sql(covers, 'extra_success', True)
    sql(attrs, 'extra_success', True)
    after = state('extra_success')
    expected = {'product_images': 4, 'product_attribute_values': 2, 'product_identifying_characteristics': 8}
    for table in tables:
        assert len(after[table]) - len(before[table]) == expected.get(table, 0), table
        for old in before[table]:
            assert old == next(row for row in after[table] if row['id'] == old['id']), table
    sql(covers, 'extra_success', True)
    sql(attrs, 'extra_success', True)
    assert state('extra_success') == after, 'No-op replay changed data'
    results.append({'case': '14 exact INSERTs, existing rows unchanged, identical replay no-op', 'result': 'PASS'})

    sql('CREATE DATABASE extra_cover_rollback TEMPLATE extra_template;')
    before = state('extra_cover_rollback')
    broken = covers.replace(proposal['covers'][-1]['storage_id'], '00000000-0000-4000-8000-000000000000')
    expect_error(broken, 'extra_cover_rollback', 'DATA002_COVER_SOURCE_CONFLICT')
    assert state('extra_cover_rollback') == before
    results.append({'case': 'Fourth cover source conflict rolls back earlier inserts', 'result': 'PASS'})

    sql('CREATE DATABASE extra_attribute_rollback TEMPLATE extra_template;')
    pitch = proposal['pitch_attributes'][1]
    sql("INSERT INTO catalog.product_attribute_values(product_id,caracteristica_id,nombre_snapshot,valor_id,valor) VALUES(" + literal(pitch['product_id']) + ',' + literal(pitch['caracteristica_id']) + ",'Color','931a4c7d-03d4-1ae2-bc95-817315fafcd6','null'::jsonb);", 'extra_attribute_rollback', True)
    before = state('extra_attribute_rollback')
    expect_error(attrs, 'extra_attribute_rollback', 'DATA002_PITCH_ATTRIBUTE_CONFLICT')
    assert state('extra_attribute_rollback') == before
    results.append({'case': 'Conflicting Pitch color rolls back eight associations and size insert', 'result': 'PASS'})

    expect_error(attrs, 'extra_attribute_rollback', 'DATA002_REQUIRE_CATALOG_OWNER', False)
    expect_error(covers, 'extra_attribute_rollback', 'DATA002_REQUIRE_CATALOG_OWNER', False)
    results.append({'case': 'Both scripts reject wrong role', 'result': 'PASS'})
    output = {'engine': 'isolated local PostgreSQL', 'external_database_urls_accepted': False,
              'results': results, 'script_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
              for name in ['additional-covers-apply-proposed.sql', 'additional-attributes-apply.sql']}}
    (ROOT / 'additional-isolated-test-results.json').write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(output))
finally:
    if started:
        command('pg_ctl', ['-D', str(directory / 'data'), '-m', 'immediate', '-w', 'stop'], quiet=True)
    safe_parent = Path(tempfile.gettempdir()).resolve()
    if directory.parent != safe_parent or not directory.name.startswith('data002-extra-'):
        raise RuntimeError('Refusing cleanup outside task temporary directory')
    shutil.rmtree(directory)
