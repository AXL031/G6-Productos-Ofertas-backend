#!/usr/bin/env bash
set -Eeuo pipefail
# Entorno efímero de prueba. No acepta URLs/credenciales de Supabase.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
scratch="$(mktemp -d)"
project="g6-mkt-ci-${RANDOM}"
network="${project}-db"
pg_name="${project}-postgres"
issuer="${project}-issuer"
compose=(docker compose -p "$project" -f docker-compose.marketplace.yml -f "$scratch/override.yml")
cleanup() {
  docker rm -f "$issuer" >/dev/null 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$pg_name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=G6 CI CA' -keyout "$scratch/ca.key" -out "$scratch/certs/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=postgres' -keyout "$scratch/certs/server.key" -out "$scratch/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:postgres,DNS:localhost,DNS:issuer,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$scratch/extensions"
openssl x509 -req -days 1 -in "$scratch/server.csr" -CA "$scratch/certs/ca.crt" -CAkey "$scratch/ca.key" -CAcreateserial -extfile "$scratch/extensions" -out "$scratch/certs/server.crt" 2>/dev/null
# Accesibles al usuario no root solo dentro del directorio temporal de CI.
chmod 755 "$scratch" "$scratch/certs"
chmod 644 "$scratch/certs/"*
docker network create "$network" >/dev/null
docker run -d --name "$pg_name" --network "$network" --network-alias postgres \
  -e POSTGRES_PASSWORD=ci-only-admin -v "$scratch/certs:/certs:ro" \
  --entrypoint sh postgres:17-alpine -c \
  'cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key' >/dev/null
for attempt in {1..60}; do
  if docker exec "$pg_name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$pg_name" psql -U postgres < scripts/ci/marketplace-empty-schema.sql >/dev/null
for service in taxonomy catalog; do
  cat > "$scratch/$service.env" <<EOF
NODE_ENV=production
PGHOST=postgres
PGPORT=5432
PGDATABASE=postgres
PGUSER=${service}_app
PGPASSWORD=ci-only-password
PGSSLMODE=verify-full
PGSSLROOTCERT=/run/certs/postgres-ca.crt
G6_DATABASE_SCHEMA=$service
G6_EXPECTED_ROLE=${service}_app
G6_CONNECTION_MODE=direct
EOF
done
cat >> "$scratch/catalog.env" <<EOF
SECURITY_ISSUER=https://issuer:3443
SECURITY_DISCOVERY_URL=https://issuer:3443/.well-known/openid-configuration
SECURITY_JWKS_URL=https://issuer:3443/keys
NODE_EXTRA_CA_CERTS=/run/certs/postgres-ca.crt
EOF
cat > "$scratch/gateway.env" <<EOF
AUTH_ISSUER=https://issuer:3443
AUTH_JWKS_URL=https://issuer:3443/keys
NODE_EXTRA_CA_CERTS=/certs/ca.crt
EOF
cat > "$scratch/override.yml" <<EOF
services:
  api-gateway:
    volumes:
      - $scratch/certs:/certs:ro
      - $root/scripts/ci:/ci:ro
networks:
  database-access:
    external: true
    name: $network
EOF
export G6_GATEWAY_ENV_FILE="$scratch/gateway.env"
export G6_TAXONOMY_ENV_FILE="$scratch/taxonomy.env"
export G6_CATALOG_ENV_FILE="$scratch/catalog.env"
export G6_TAXONOMY_CA_FILE="$scratch/certs/ca.crt"
export G6_CATALOG_CA_FILE="$scratch/certs/ca.crt"
export G6_GATEWAY_HOST_PORT=0
"${compose[@]}" build
# Arranque sin configuración: falla, sin sustituir el smoke positivo posterior.
for service in taxonomy catalog; do
  image="$project-${service}-svc"
  set +e
  output="$(docker run --rm "$image" 2>&1)"
  code=$?
  set -e
  [[ "$code" -ne 0 && "$output" == *APPLICATION_START_FAILED* ]]
done
"${compose[@]}" up -d --wait --wait-timeout 90
service_network="${project}_services"
docker run -d --name "$issuer" --network "$service_network" --network-alias issuer \
  -v "$scratch/certs:/certs:ro" -v "$root/scripts/ci:/ci:ro" \
  --entrypoint node "$project-api-gateway" /ci/issuer.mjs >/dev/null
for attempt in {1..30}; do
  if "${compose[@]}" exec -T api-gateway node -e "fetch('https://issuer:3443/keys').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
"${compose[@]}" exec -T api-gateway node /ci/marketplace-probe.mjs
# TLS negativo: CA ajena y hostname ajeno deben impedir el arranque.
for override in PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt PGHOST=wrong-host; do
  set +e
  output="$("${compose[@]}" run --rm --no-deps -e G6_CONNECT_HOST=postgres -e "$override" taxonomy-svc 2>&1)"
  code=$?
  set -e
  [[ "$code" -ne 0 && "$output" == *APPLICATION_START_FAILED* ]]
done
# Proveedor real y cliente HTTP de Catalog, sin sustituir el puerto comercial.
"${compose[@]}" exec -T catalog-svc node --input-type=module -e "
import assert from 'node:assert/strict';
import { Database } from './dist/apps/catalog-svc/database.js';
import { PostgresCatalogRepository } from './dist/apps/catalog-svc/postgres-catalog.repository.js';
import { TaxonomyClient } from './dist/apps/catalog-svc/taxonomy.client.js';
const db = new Database();
try {
  await db.verifyIdentity();
  const repo = new PostgresCatalogRepository(db);
  const page = await repo.listCandidates({canal:'MARKETPLACE',pagina:1,tamanio:20,orden:'NOMBRE_ASC'});
  assert.equal(page.total, 0);
  assert.equal(await repo.findCandidateBySlug('inexistente'), null);
  await assert.rejects(new TaxonomyClient().category('inexistente'), e => e.getStatus() === 422);
} finally { await db.onModuleDestroy(); }
console.log('PASS: Catalog Drizzle PostgreSQL y Catalog -> Taxonomy HTTP');"
docker stop "$pg_name" >/dev/null
"${compose[@]}" exec -T api-gateway node /ci/marketplace-probe.mjs offline
docker start "$pg_name" >/dev/null
for attempt in {1..60}; do
  if "${compose[@]}" exec -T taxonomy-svc node -e "fetch('http://127.0.0.1:3006/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
"${compose[@]}" exec -T api-gateway node /ci/marketplace-probe.mjs
"${compose[@]}" stop -t 10 catalog-svc taxonomy-svc
for service in catalog-svc taxonomy-svc; do
  id="$("${compose[@]}" ps -a -q "$service")"
  code="$(docker inspect --format '{{.State.ExitCode}}' "$id")"
  [[ "$code" == 0 || "$code" == 143 ]]
done
printf 'PASS: arranque positivo, TLS, DNS privado, JWT RS256, correlación, indisponibilidad y recuperación.\n'
