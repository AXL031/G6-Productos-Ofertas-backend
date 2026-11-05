#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${INVENTORY_TEST_IMAGE:-inventory-svc:ci}
DOCS_ROOT=${G6_DOCS_ROOT:-.ci/G6-Productos-Ofertas-docs}
RUN_ID="$(node -p "require('node:crypto').randomUUID().replaceAll('-', '')")"
LABEL="g6.inventory.smoke=${RUN_ID}"
NETWORK="inventory-smoke-${RUN_ID}"
PG_CONTAINER="inventory-smoke-pg-${RUN_ID}"
APP_CONTAINER="inventory-smoke-app-${RUN_ID}"
BAD_CONTAINER="inventory-smoke-bad-${RUN_ID}"
TLS_DIR="$(mktemp -d)"
PG_PASSWORD="ci-inventory-${RUN_ID}"
cleanup() {
  docker rm -f "$APP_CONTAINER" "$BAD_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
  rm -rf -- "$TLS_DIR"
}
trap cleanup EXIT INT TERM

for binary in docker openssl curl; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    printf 'FALLO: herramienta requerida ausente: %s\n' "$binary" >&2
    exit 1
  fi
done
test -f "$DOCS_ROOT/datos/inventory-svc/migration.sql"
test -f "$DOCS_ROOT/datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql"
test -f apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql
docker image inspect "$IMAGE" >/dev/null

# CA y certificado efímeros. El SAN coincide exactamente con el hostname usado por node-postgres.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
  -subj "//CN=g6-inventory-smoke-${RUN_ID}" \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$TLS_DIR/server.key" \
  -out "$TLS_DIR/server.csr" -subj '//CN=inventory-pg' \
  -addext 'subjectAltName=DNS:inventory-pg' >/dev/null 2>&1
openssl x509 -req -in "$TLS_DIR/server.csr" -CA "$TLS_DIR/ca.crt" \
  -CAkey "$TLS_DIR/ca.key" -CAcreateserial -out "$TLS_DIR/server.crt" \
  -days 1 -copy_extensions copy >/dev/null 2>&1
chmod 600 "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/ca.crt"
CA_SOURCE="$TLS_DIR/ca.crt"
if command -v cygpath >/dev/null 2>&1; then CA_SOURCE="$(cygpath -w "$CA_SOURCE")"; fi

docker network create --label "$LABEL" "$NETWORK" >/dev/null
docker run -d --name "$PG_CONTAINER" --label "$LABEL" --network "$NETWORK" --network-alias inventory-pg \
  -e POSTGRES_USER=inventory_ci -e "POSTGRES_PASSWORD=$PG_PASSWORD" \
  -e POSTGRES_DB=inventory_ci postgres:17-alpine >/dev/null

for attempt in {1..60}; do
  if docker exec "$PG_CONTAINER" pg_isready -U inventory_ci -d inventory_ci >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$PG_CONTAINER" pg_isready -U inventory_ci -d inventory_ci >/dev/null

docker cp "$TLS_DIR/server.crt" "$PG_CONTAINER:/tmp/inventory-server.crt"
docker cp "$TLS_DIR/server.key" "$PG_CONTAINER:/tmp/inventory-server.key"
docker cp "$TLS_DIR/ca.crt" "$PG_CONTAINER:/tmp/inventory-ca.crt"
docker exec "$PG_CONTAINER" sh -c 'chown postgres:postgres /tmp/inventory-server.key /tmp/inventory-server.crt && chmod 600 /tmp/inventory-server.key'
docker exec "$PG_CONTAINER" psql -U inventory_ci -d inventory_ci -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/tmp/inventory-server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/tmp/inventory-server.key'"
docker restart "$PG_CONTAINER" >/dev/null
for attempt in {1..60}; do
  if docker exec "$PG_CONTAINER" pg_isready -U inventory_ci -d inventory_ci >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$PG_CONTAINER" pg_isready -U inventory_ci -d inventory_ci >/dev/null

# In-container psql proves CA and hostname verification and records TLS authentication.
docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql \
  "host=inventory-pg dbname=inventory_ci user=inventory_ci sslmode=verify-full sslrootcert=/tmp/inventory-ca.crt" \
  -v ON_ERROR_STOP=1 -Atc "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()" | grep -qx t

apply_sql() {
  docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql \
    -h 127.0.0.1 -U inventory_ci -d inventory_ci -v ON_ERROR_STOP=1
}
apply_sql < "$DOCS_ROOT/datos/inventory-svc/migration.sql"
apply_sql < "$DOCS_ROOT/datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql"
apply_sql < apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql \
  "host=inventory-pg dbname=inventory_ci user=inventory_ci sslmode=verify-full sslrootcert=/tmp/inventory-ca.crt" \
  -v ON_ERROR_STOP=1 -Atc 'SELECT 1' | grep -qx 1

# Probe from a separate container so Docker's private DNS and the same Node TLS
# stack used by Inventory are ready before its fail-closed bootstrap runs.
PG_PROBE='const pg=require("pg");const fs=require("node:fs");const pool=new pg.Pool({host:process.env.PGHOST,port:5432,database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD,ssl:{ca:fs.readFileSync(process.env.PGSSLROOTCERT,"utf8"),rejectUnauthorized:true}});pool.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").then(r=>{if(r.rows[0]?.ssl!==true)process.exitCode=1}).catch(()=>{process.exitCode=1}).finally(()=>pool.end())'
PG_PROBE_READY=false
for attempt in {1..30}; do
  if docker run --rm --network "$NETWORK" \
    --mount "type=bind,source=$CA_SOURCE,target=/run/g6-ci-certs/ca.crt,readonly" \
    -e PGHOST=inventory-pg -e PGDATABASE=inventory_ci -e PGUSER=inventory_ci \
    -e "PGPASSWORD=$PG_PASSWORD" -e PGSSLROOTCERT=/run/g6-ci-certs/ca.crt \
    --entrypoint node "$IMAGE" -e "$PG_PROBE" >/dev/null 2>&1; then
    PG_PROBE_READY=true
    break
  fi
  sleep 1
done
[[ "$PG_PROBE_READY" == true ]]

# Positive production startup: private DNS, verify-full TLS and read-only CA mount.
docker run -d --name "$APP_CONTAINER" --label "$LABEL" --network "$NETWORK" \
  --network-alias inventory-smoke-app -p 127.0.0.1::3005 \
  -e NODE_ENV=production -e PORT=3005 -e INVENTORY_SVC_PORT=3005 \
  -e PGHOST=inventory-pg -e PGPORT=5432 -e PGDATABASE=inventory_ci \
  -e PGUSER=inventory_ci -e "PGPASSWORD=$PG_PASSWORD" \
  -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/run/g6-ci-certs/ca.crt \
  --mount "type=bind,source=$CA_SOURCE,target=/run/g6-ci-certs/ca.crt,readonly" \
  "$IMAGE" >/dev/null
APP_PORT="$(docker port "$APP_CONTAINER" 3005/tcp | awk -F: '{print $NF}')"
BASE="http://127.0.0.1:${APP_PORT}"
wait_http() {
  local url=$1 expected=$2 status=''
  for attempt in {1..60}; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)"
    [[ "$status" == "$expected" ]] && return 0
    sleep 1
  done
  printf 'FALLO: %s respondió HTTP %s; esperado %s.\n' "$url" "$status" "$expected" >&2
  return 1
}
wait_http "$BASE/health" 200
wait_http "$BASE/health/readiness" 200

HEALTHY=''
for attempt in {1..60}; do
  HEALTHY="$(docker inspect --format '{{.State.Health.Status}}' "$APP_CONTAINER")"
  [[ "$HEALTHY" == healthy ]] && break
  sleep 1
done
[[ "$HEALTHY" == healthy ]]
printf 'CORRECTO: arranque production, /health=200, readiness=200, Docker health=healthy.\n'
printf 'CORRECTO: PostgreSQL autenticó TLS verify-full y hostname SAN inventory-pg con CA sintética.\n'

# Break only this private network path; keep the inventory container alive.
docker network disconnect "$NETWORK" "$PG_CONTAINER"
wait_http "$BASE/health" 200
wait_http "$BASE/health/readiness" 503
[[ "$(docker inspect --format '{{.State.Running}}' "$APP_CONTAINER")" == true ]]
printf 'CORRECTO: con PostgreSQL separado temporalmente, liveness=200 y readiness=503.\n'
docker network connect --alias inventory-pg "$NETWORK" "$PG_CONTAINER"
wait_http "$BASE/health/readiness" 200
printf 'CORRECTO: readiness volvió a 200 tras reconectar PostgreSQL.\n'

# A distinct container with the same image and no PG settings must fail closed.
set +e
docker run -d --name "$BAD_CONTAINER" --label "$LABEL" --network "$NETWORK" \
  -p 127.0.0.1::3005 "$IMAGE" >/dev/null 2>&1
BAD_RUN_STATUS=$?
set -e
if [[ "$BAD_RUN_STATUS" -ne 0 ]]; then
  # docker run can return non-zero when the process exits before the attach handshake.
  docker inspect "$BAD_CONTAINER" >/dev/null
fi
for attempt in {1..30}; do
  BAD_STATE="$(docker inspect --format '{{.State.Status}}' "$BAD_CONTAINER")"
  [[ "$BAD_STATE" == exited ]] && break
  sleep 1
done
[[ "$BAD_STATE" == exited ]]
BAD_EXIT="$(docker inspect --format '{{.State.ExitCode}}' "$BAD_CONTAINER")"
[[ "$BAD_EXIT" != 0 ]]
BAD_PORT="$(docker port "$BAD_CONTAINER" 3005/tcp 2>/dev/null | awk -F: '{print $NF}' || true)"
if [[ -n "$BAD_PORT" ]]; then
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BAD_PORT}/health" || true)" != 200 ]]
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BAD_PORT}/health/readiness" || true)" != 200 ]]
fi
BAD_LOGS="$(docker logs "$BAD_CONTAINER" 2>&1)"
if grep -Fq "$PG_PASSWORD" <<< "$BAD_LOGS" || grep -Eqi 'postgres(ql)?://[^[:space:]]+:[^[:space:]@]+@|PGPASSWORD=' <<< "$BAD_LOGS"; then
  printf 'FALLO: las trazas del arranque negativo exponen credenciales o DSN.\n' >&2
  exit 1
fi
printf 'CORRECTO: sin PostgreSQL, el mismo contenedor terminó con código %s y no sirvió health/readiness 200; logs sin secretos.\n' "$BAD_EXIT"

APP_LOGS="$(docker logs "$APP_CONTAINER" 2>&1)"
if grep -Fq "$PG_PASSWORD" <<< "$APP_LOGS"; then
  printf 'FALLO: las trazas del arranque válido exponen la credencial sintética.\n' >&2
  exit 1
fi
printf 'CORRECTO: los logs del arranque válido no contienen credenciales.\n'
cleanup
trap - EXIT INT TERM
printf 'CORRECTO: contenedores, red privada y certificados temporales fueron eliminados.\n'
