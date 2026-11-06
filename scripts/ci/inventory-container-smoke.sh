#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${INVENTORY_TEST_IMAGE:-inventory-svc:ci}
DOCS_ROOT=${G6_DOCS_ROOT:-.ci/G6-Productos-Ofertas-docs}
CURRENT_STAGE='preparación'
DOCKER_TOUCHED=false
RUN_ID=''
LABEL=''
NETWORK=''
PG_CONTAINER=''
APP_CONTAINER=''
BAD_CONTAINER=''
TLS_DIR=''
PG_PASSWORD=''
CA_SOURCE=''
stage() {
  CURRENT_STAGE=$1
  printf '[inventory-smoke] etapa: %s\n' "$CURRENT_STAGE"
}
report_postgres() {
  if ! docker container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    printf '[inventory-smoke] PostgreSQL: contenedor inexistente.\n'
    return 0
  fi
  local state code summary
  state="$(docker container inspect --format '{{.State.Status}}' "$PG_CONTAINER")"
  code="$(docker container inspect --format '{{.State.ExitCode}}' "$PG_CONTAINER")"
  case "$state" in
    running)
      if docker exec "$PG_CONTAINER" pg_isready -q -h 127.0.0.1 -p 5432 -U inventory_ci -d inventory_ci; then
        printf '[inventory-smoke] PostgreSQL: disponible por TCP.\n'
      else
        code=$?
        case "$code" in
          1) printf '[inventory-smoke] PostgreSQL: rechazando conexiones TCP.\n' ;;
          2) printf '[inventory-smoke] PostgreSQL: aún no responde por TCP.\n' ;;
          3) printf '[inventory-smoke] PostgreSQL: pg_isready tiene argumentos inválidos.\n' ;;
          *) printf '[inventory-smoke] PostgreSQL: docker exec/pg_isready falló (%s).\n' "$code" ;;
        esac
      fi
      ;;
    created|restarting) printf '[inventory-smoke] PostgreSQL: contenedor inicializando (%s).\n' "$state" ;;
    *) printf '[inventory-smoke] PostgreSQL: contenedor detenido (estado %s, salida %s).\n' "$state" "$code" ;;
  esac
  if ! summary="$(docker logs --tail 60 "$PG_CONTAINER" 2>&1 | awk '
    /starting PostgreSQL/ { print "proceso iniciado" }
    /PostgreSQL init process complete/ { print "inicialización completa" }
    /database system is ready to accept connections/ { print "servidor listo" }
    /database system is shut down/ { print "servidor detenido" }
    /FATAL|PANIC|ERROR|permission denied|could not|invalid/ { print "error de arranque registrado (detalle redactado)" }
  ' | sort -u | tail -n 8)"; then summary=''; fi
  if [[ -n "$summary" ]]; then
    while IFS= read -r event; do printf '[inventory-smoke] PostgreSQL log: %s.\n' "$event"; done <<< "$summary"
  else
    printf '[inventory-smoke] PostgreSQL: eventos de arranque no disponibles o no reconocidos.\n'
  fi
}
on_error() {
  local code=$1 line=$2
  trap - ERR
  printf '[inventory-smoke] FALLO: etapa=%s línea=%s código=%s.\n' "$CURRENT_STAGE" "$line" "$code" >&2
  if [[ "$DOCKER_TOUCHED" == true ]] && docker info >/dev/null 2>&1; then report_postgres >&2; fi
  exit "$code"
}
wait_for_postgres_tcp() {
  local limit=$1 attempt state code
  for ((attempt=1; attempt<=limit; attempt++)); do
    state="$(docker container inspect --format '{{.State.Status}}' "$PG_CONTAINER")"
    case "$state" in
      exited|dead|removing)
        printf '[inventory-smoke] PostgreSQL detenido antes de aceptar TCP.\n' >&2
        report_postgres >&2
        return 1
        ;;
      created|restarting) code=2 ;;
      running)
        if docker exec "$PG_CONTAINER" pg_isready -q -h 127.0.0.1 -p 5432 -U inventory_ci -d inventory_ci; then
          printf '[inventory-smoke] PostgreSQL TCP listo (%s/%s).\n' "$attempt" "$limit"
          return 0
        else
          code=$?
        fi
        ;;
      *) printf '[inventory-smoke] Estado PostgreSQL inesperado: %s.\n' "$state" >&2; return 1 ;;
    esac
    case "$code" in
      1|2)
        if (( attempt == 1 || attempt % 10 == 0 )); then
          if [[ "$code" == 1 ]]; then printf '[inventory-smoke] PostgreSQL rechaza TCP durante inicio (%s/%s).\n' "$attempt" "$limit"
          else printf '[inventory-smoke] PostgreSQL aún inicializa; TCP no está listo (%s/%s).\n' "$attempt" "$limit"; fi
        fi
        sleep 1
        ;;
      3) printf '[inventory-smoke] pg_isready: argumentos inválidos; no se reintenta.\n' >&2; return 1 ;;
      *) printf '[inventory-smoke] docker exec/pg_isready falló (%s); no se reintenta.\n' "$code" >&2; return 1 ;;
    esac
  done
  printf '[inventory-smoke] timeout: PostgreSQL no aceptó TCP en %s segundos.\n' "$limit" >&2
  report_postgres >&2
  return 1
}
cleanup() {
  local result=$? failed=false name
  trap - EXIT ERR INT TERM
  printf '[inventory-smoke] etapa: limpieza.\n'
  if [[ "$DOCKER_TOUCHED" == true ]]; then
    if docker info >/dev/null 2>&1; then
      for name in "$APP_CONTAINER" "$BAD_CONTAINER" "$PG_CONTAINER"; do
        if docker container inspect "$name" >/dev/null 2>&1; then
          if ! docker container rm --force "$name" >/dev/null; then failed=true; fi
        fi
      done
      if docker network inspect "$NETWORK" >/dev/null 2>&1 && ! docker network rm "$NETWORK" >/dev/null; then failed=true; fi
    else
      printf '[inventory-smoke] FALLO de limpieza: Docker no responde.\n' >&2
      failed=true
    fi
  fi
  if [[ -d "$TLS_DIR" ]] && ! rm -rf -- "$TLS_DIR"; then failed=true; fi
  if [[ "$failed" == true ]]; then exit 1; fi
  if [[ "$result" -ne 0 ]]; then exit "$result"; fi
  printf '[inventory-smoke] limpieza completa.\n'
}
trap cleanup EXIT
trap 'on_error "$?" "$LINENO"' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

stage 'preparación de identificadores aislados'
RUN_ID="$(node -p "require('node:crypto').randomUUID().replaceAll('-', '')")"
LABEL="g6.inventory.smoke=${RUN_ID}"
NETWORK="inventory-smoke-${RUN_ID}"
PG_CONTAINER="inventory-smoke-pg-${RUN_ID}"
APP_CONTAINER="inventory-smoke-app-${RUN_ID}"
BAD_CONTAINER="inventory-smoke-bad-${RUN_ID}"
TLS_DIR="$(mktemp -d)"
PG_PASSWORD="ci-inventory-${RUN_ID}"

stage 'validación de herramientas, archivos e imagen'
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
docker info >/dev/null
DOCKER_TOUCHED=true

# CA y certificado efímeros. El SAN coincide exactamente con el hostname usado por node-postgres.
stage 'generación de certificados'
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

stage 'creación de red Docker'
docker network create --label "$LABEL" "$NETWORK" >/dev/null
stage 'creación de PostgreSQL desechable'
docker run -d --name "$PG_CONTAINER" --label "$LABEL" --network "$NETWORK" --network-alias inventory-pg \
  -e POSTGRES_USER=inventory_ci -e "POSTGRES_PASSWORD=$PG_PASSWORD" \
  -e POSTGRES_DB=inventory_ci postgres:17-alpine >/dev/null

stage 'inicialización y disponibilidad PostgreSQL por TCP'
# La imagen oficial inicia temporalmente PostgreSQL solo por socket Unix durante initdb.
wait_for_postgres_tcp 90

stage 'configuración TLS de PostgreSQL'
docker cp "$TLS_DIR/server.crt" "$PG_CONTAINER:/tmp/inventory-server.crt"
docker cp "$TLS_DIR/server.key" "$PG_CONTAINER:/tmp/inventory-server.key"
docker cp "$TLS_DIR/ca.crt" "$PG_CONTAINER:/tmp/inventory-ca.crt"
docker exec "$PG_CONTAINER" sh -c 'chown postgres:postgres /tmp/inventory-server.key /tmp/inventory-server.crt && chmod 600 /tmp/inventory-server.key'
docker exec "$PG_CONTAINER" psql -U inventory_ci -d inventory_ci -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/tmp/inventory-server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/tmp/inventory-server.key'"
docker restart "$PG_CONTAINER" >/dev/null
wait_for_postgres_tcp 90

# In-container psql proves CA and hostname verification and records TLS authentication.
docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql \
  "host=inventory-pg dbname=inventory_ci user=inventory_ci sslmode=verify-full sslrootcert=/tmp/inventory-ca.crt" \
  -v ON_ERROR_STOP=1 -Atc "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()" | grep -qx t

apply_sql() {
  docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql \
    -h 127.0.0.1 -U inventory_ci -d inventory_ci -v ON_ERROR_STOP=1
}
stage 'aplicación de migraciones'
apply_sql < "$DOCS_ROOT/datos/inventory-svc/migration.sql"
apply_sql < "$DOCS_ROOT/datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql"
apply_sql < apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql \
  "host=inventory-pg dbname=inventory_ci user=inventory_ci sslmode=verify-full sslrootcert=/tmp/inventory-ca.crt" \
  -v ON_ERROR_STOP=1 -Atc 'SELECT 1' | grep -qx 1

# Probe from a separate container so Docker's private DNS and the same Node TLS
# stack used by Inventory are ready before its fail-closed bootstrap runs.
stage 'preflight TLS verify-full de Node en red privada'
PG_PROBE='const pg=require("pg");const fs=require("node:fs");const pool=new pg.Pool({host:process.env.PGHOST,port:5432,database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD,ssl:{ca:fs.readFileSync(process.env.PGSSLROOTCERT,"utf8"),rejectUnauthorized:true}});pool.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").then(r=>{if(r.rows[0]?.ssl!==true)throw Object.assign(new Error("TLS_NOT_ACTIVE"),{code:"TLS_NOT_ACTIVE"})}).catch(e=>{console.error("probe_code="+(e.code||"UNKNOWN").replace(/[^A-Z0-9_]/gi,"_").slice(0,80));process.exitCode=1}).finally(()=>pool.end())'
PG_PROBE_READY=false
for attempt in {1..30}; do
  if probe_output="$(docker run --rm --network "$NETWORK" \
    --mount "type=bind,source=$CA_SOURCE,target=/run/g6-ci-certs/ca.crt,readonly" \
    -e PGHOST=inventory-pg -e PGDATABASE=inventory_ci -e PGUSER=inventory_ci \
    -e "PGPASSWORD=$PG_PASSWORD" -e PGSSLROOTCERT=/run/g6-ci-certs/ca.crt \
    --entrypoint node "$IMAGE" -e "$PG_PROBE" 2>&1)"; then
    PG_PROBE_READY=true
    break
  else
    probe_status=$?
  fi
  probe_code="$(sed -n 's/^probe_code=//p' <<< "$probe_output" | tail -n 1)"
  case "$probe_code" in
    ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ECONNRESET)
      printf '[inventory-smoke] probe TLS/DNS transitorio (%s; intento %s/30).\n' "$probe_code" "$attempt"
      sleep 1 ;;
    '')
      if grep -Eqi 'invalid mount config|mounts denied|source path must be absolute|bind source path does not exist' <<< "$probe_output"; then
        printf '[inventory-smoke] probe Node no ejecutó: Docker rechazó el montaje de CA (código %s).\n' "$probe_status" >&2
      elif grep -Eqi 'executable file not found|no such file or directory' <<< "$probe_output"; then
        printf '[inventory-smoke] probe Node no ejecutó: falta archivo o ejecutable requerido (código %s).\n' "$probe_status" >&2
      else
        printf '[inventory-smoke] probe Node no ejecutó: error Docker sin categoría reconocida (código %s).\n' "$probe_status" >&2
      fi
      exit 1 ;;
    *) printf '[inventory-smoke] probe TLS/DNS rechazado (%s); no se reintenta.\n' "$probe_code" >&2; exit 1 ;;
  esac
done
if [[ "$PG_PROBE_READY" != true ]]; then printf '[inventory-smoke] timeout del probe TLS/DNS Node.\n' >&2; exit 1; fi

# Positive production startup: private DNS, verify-full TLS and read-only CA mount.
stage 'arranque productivo de Inventory'
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
  local url=$1 expected=$2 limit=${3:-60} status='' start=$SECONDS attempt=0 code
  while (( SECONDS - start < limit )); do
    attempt=$((attempt + 1))
    # Inventory allows five seconds for PostgreSQL connection acquisition; give
    # readiness probes time to return 503 instead of canceling them at 3 seconds.
    if status="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"; then code=0; else code=$?; status=000; fi
    [[ "$status" == "$expected" ]] && return 0
    case "$code" in 0|6|7|28|52|56) ;; *) printf '[inventory-smoke] curl falló (%s); no se reintenta.\n' "$code" >&2; return 1 ;; esac
    if [[ "$(docker container inspect --format '{{.State.Status}}' "$APP_CONTAINER")" != running ]]; then
      printf '[inventory-smoke] Inventory terminó durante espera HTTP.\n' >&2
      return 1
    fi
    if (( SECONDS - start < limit )); then sleep 1; fi
  done
  printf '[inventory-smoke] timeout HTTP de %s segundos: observado=%s esperado=%s.\n' "$limit" "$status" "$expected" >&2
  return 1
}
stage 'salud de Inventory y healthcheck Docker'
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
wait_for_postgres_tcp 60
wait_http "$BASE/health/readiness" 200
printf 'CORRECTO: readiness volvió a 200 tras reconectar PostgreSQL.\n'

# A distinct container with the same image and no PG settings must fail closed.
stage 'rechazo fail-closed sin configuración'
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
if BAD_PORT_OUTPUT="$(docker port "$BAD_CONTAINER" 3005/tcp 2>/dev/null)"; then
  BAD_PORT="$(awk -F: '{print $NF}' <<< "$BAD_PORT_OUTPUT")"
  if [[ -z "$BAD_PORT" ]]; then printf '[inventory-smoke] Docker reportó puerto vacío para arranque inválido.\n' >&2; exit 1; fi
  for path in health health/readiness; do
    if status="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BAD_PORT}/${path}" 2>/dev/null)"; then code=0; else code=$?; status=000; fi
    if [[ "$status" == 200 ]]; then printf '[inventory-smoke] arranque inválido sirvió HTTP 200 (%s).\n' "$path" >&2; exit 1; fi
    case "$code" in 0|6|7|28|52|56) ;; *) printf '[inventory-smoke] curl negativo falló (%s).\n' "$code" >&2; exit 1 ;; esac
  done
else
  BAD_PORT_STATUS="$(docker inspect --format '{{if index .NetworkSettings.Ports "3005/tcp"}}published{{else}}unpublished{{end}}' "$BAD_CONTAINER")"
  if [[ "$BAD_PORT_STATUS" != unpublished || "$BAD_STATE" != exited || "$BAD_EXIT" == 0 ]]; then
    printf '[inventory-smoke] no se pudo probar HTTP y no se confirmó contenedor detenido sin puerto.\n' >&2
    exit 1
  fi
  printf '[inventory-smoke] HTTP health/readiness no publicables: proceso exited y puerto 3005 no publicado.\n'
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
