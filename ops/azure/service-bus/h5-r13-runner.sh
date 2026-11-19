#!/bin/sh
set -eu

trap 'touch /status/done' EXIT
mkdir -p /status/artifacts/inventory-svc /status/artifacts/promotions-svc
chmod 0777 /status/artifacts/inventory-svc /status/artifacts/promotions-svc

workdir="$(mktemp -d)"
cd "$workdir"
wget -q -T 30 -O source.tgz "https://codeload.github.com/AXL031/G6-Productos-Ofertas-backend/tar.gz/$G6_SOURCE_SHA"
printf '%s  source.tgz\n' "$G6_SOURCE_ARCHIVE_SHA256" | sha256sum -c -
tar -xzf source.tgz --strip-components 1
npm ci --no-audit --no-fund

for service in inventory-svc promotions-svc; do
  elapsed=0
  until [ -f "/status/artifacts/$service/ready" ]; do
    [ "$elapsed" -lt 90 ] || { printf 'IMAGE_ARTIFACT_UNAVAILABLE %s\n' "$service" >&2; exit 1; }
    sleep 1
    elapsed=$((elapsed + 1))
  done
  mkdir -p "dist/apps/$service"
  cp -R "/status/artifacts/$service/." "dist/apps/$service/"
done

# Rewrite only the disposable suite's two service import prefixes.
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const spec = 'tests/h5/inventory-promotions.postgres.e2e-spec.ts';
const source = readFileSync(spec, 'utf8');
const imports = /from '\.\.\/\.\.\/apps\/(inventory-svc|promotions-svc)\/src\//g;
const services = new Set();
const compiled = source.replace(imports, (_, service) => {
  services.add(service);
  return "from '../../dist/apps/" + service + '/';
});
if (services.size !== 2) throw new Error('PUBLISHED_SERVICE_IMPORTS_REQUIRED');
writeFileSync(spec, compiled);
NODE

export PROMOTIONS_H5_TEST_DATABASE_URL="postgresql://postgres:$G6_H5_POSTGRES_PASSWORD@127.0.0.1:5432/$G6_H5_POSTGRES_DATABASE"
unset G6_H5_POSTGRES_PASSWORD

node <<'NODE'
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
async function check() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const db = new Client({
      connectionString: process.env.PROMOTIONS_H5_TEST_DATABASE_URL,
      connectionTimeoutMillis: 1000,
    });
    try {
      await db.connect();
      await db.query('SELECT 1');
      return;
    } catch {
      await delay(1000);
    } finally {
      await db.end().catch(() => {});
    }
  }
  throw new Error('DISPOSABLE_POSTGRES_START_FAILED');
}
check().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE

npm run test:e2e -- --maxWorkers=1 tests/h5/inventory-promotions.postgres.e2e-spec.ts \
  -t 'R13 uses the laboratory broker'
printf 'G6_H5_R13_AZURE_PASS sha=%s\n' "$G6_SOURCE_SHA"
