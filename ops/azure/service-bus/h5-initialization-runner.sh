#!/bin/sh
set -eu
trap 'touch /status/done' EXIT

case "$LAB_SUITE" in
  initialization)
    G6_H5_LAB_SPEC='tests/h5/catalog-initialization.azure.e2e-spec.ts'
    if [ -n "${G6_H5_LAB_TAXONOMY_CLIENT_ID:-}" ]; then export G6_H5_TAXONOMY_REAL_AZURE=1; fi
    ;;
  price-fanout) G6_H5_LAB_SPEC='tests/h5/pricing-fanout.azure.e2e-spec.ts' ;;
  *) exit 1 ;;
esac
export G6_H5_LAB_SPEC
for service in $G6_H5_INIT_SERVICES; do
  mkdir -p "/status/artifacts/$service"
  chmod 0777 "/status/artifacts/$service"
done

cd "$(mktemp -d)"
wget -q -T 30 -O source.tgz "https://codeload.github.com/AXL031/G6-Productos-Ofertas-backend/tar.gz/$G6_SOURCE_SHA"
printf '%s  source.tgz\n' "$G6_SOURCE_ARCHIVE_SHA256" | sha256sum -c -
tar -xzf source.tgz --strip-components 1
npm ci --no-audit --no-fund

for service in $G6_H5_INIT_SERVICES; do
  i=0
  until [ -f "/status/artifacts/$service/ready" ]; do
    [ "$i" -lt 90 ] || { echo "IMAGE_ARTIFACT_UNAVAILABLE $service" >&2; exit 1; }
    sleep 1
    i=$((i + 1))
  done
  mkdir -p "dist/apps/$service"
  cp -R "/status/artifacts/$service/." "dist/apps/$service/"
done

export G6_H5_INIT_PG_URL="postgresql://postgres:$G6_H5_POSTGRES_PASSWORD@127.0.0.1:5432/$G6_H5_POSTGRES_DATABASE"
export G6_H5_FANOUT_PG_URL="$G6_H5_INIT_PG_URL"
unset G6_H5_POSTGRES_PASSWORD
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';

const spec = process.env.G6_H5_LAB_SPEC;
const found = new Set();
const expected = process.env.G6_H5_INIT_SERVICES.split(' ');
const rewritten = readFileSync(spec, 'utf8').replace(
  /from '\.\.\/\.\.\/apps\/([a-z-]+-svc)\/src\//g,
  (original, service) => {
    if (!expected.includes(service)) return original;
    found.add(service);
    return "from '../../dist/apps/" + service + '/';
  },
);
if (found.size !== expected.length) throw new Error('PUBLISHED_SERVICE_IMPORTS_REQUIRED');
writeFileSync(spec, rewritten);

for (let attempt = 0; attempt < 30; attempt++) {
  const db = new Client({ connectionString: process.env.G6_H5_INIT_PG_URL, connectionTimeoutMillis: 1000 });
  try {
    await db.connect();
    await db.query('SELECT 1');
    break;
  } catch {
    if (attempt === 29) throw new Error('DISPOSABLE_POSTGRES_START_FAILED');
    await setTimeout(1000);
  } finally {
    await db.end().catch(() => {});
  }
}
NODE
case "$LAB_SUITE" in
  initialization)
    G6_H5_INIT_REAL_AZURE=1 npm run test:e2e -- --maxWorkers=1 "$G6_H5_LAB_SPEC"
    printf 'G6_H5_INITIALIZATION_AZURE_PASS source=%s flows=R06,R07,R11,R15\n' "$G6_SOURCE_SHA"
    if [ "${G6_H5_TAXONOMY_REAL_AZURE:-0}" = 1 ]; then
      printf 'G6_H5_TAXONOMY_AZURE_PASS source=%s flows=R09,R18\n' "$G6_SOURCE_SHA"
    fi
    ;;
  price-fanout)
    G6_H5_FANOUT_REAL_AZURE=1 npm run test:e2e -- --maxWorkers=1 "$G6_H5_LAB_SPEC"
    printf 'G6_H5_FANOUT_AZURE_PASS source=%s flows=R16,R17\n' "$G6_SOURCE_SHA"
    ;;
esac
