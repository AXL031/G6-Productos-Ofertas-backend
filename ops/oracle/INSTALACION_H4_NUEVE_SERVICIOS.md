# Instalación documental del ejecutor Oracle v5 y topología HTTP

Procedimiento exclusivamente documental. No se ejecutó en Oracle. Requiere checkout autorizado, aprobación operativa específica y ventana de mantenimiento. No cambia imágenes activas, active-image, previous-image, runtime.env, secretos, Caddy ni redes productivas. No ejecutar up, pull, reinicios ni comandos destructivos globales.

## Gate de procedencia del checkout

El gate acepta solo URLs canónicas de GitHub para Taller-SW-Web/G6-Productos-Ofertas-backend por HTTPS o SSH. HTTPS fuerza validación TLS; SSH requiere modo no interactivo y clave de host ya confiable (StrictHostKeyChecking=yes). Comprueba tanto la URL de lectura como la URL de push configuradas en origin, consulta directamente refs/heads/master en esa URL y falla si hay checkout sucio, referencia inaccesible, salida ambigua o SHA distinto. No usa origin/master local.

Ejecutar estas funciones, pruebas fixture y pasos operativos en una misma sesión Bash. Las fixtures son locales, no usan sudo ni consultan repositorios remotos.

```bash
fail_source() { printf 'FALLO CERRADO: %s\n' "$*" >&2; return 1; }
is_authorized_repository_url() {
  case "$1" in
    https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend|https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend.git|\
    git@github.com:Taller-SW-Web/G6-Productos-Ofertas-backend|git@github.com:Taller-SW-Web/G6-Productos-Ofertas-backend.git|\
    ssh://git@github.com/Taller-SW-Web/G6-Productos-Ofertas-backend|ssh://git@github.com/Taller-SW-Web/G6-Productos-Ofertas-backend.git) return 0 ;;
    *) return 1 ;;
  esac
}
validate_source_facts() {
  local url="$1" checkout_sha="$2" fetch_state="$3" master_sha="$4" worktree_state="$5"
  is_authorized_repository_url "$url" || { fail_source 'origin no apunta al repositorio oficial permitido'; return 1; }
  [[ "$worktree_state" == clean ]] || { fail_source 'el checkout tiene cambios locales'; return 1; }
  [[ "$fetch_state" == reachable ]] || { fail_source 'no se pudo consultar refs/heads/master oficial'; return 1; }
  [[ "$checkout_sha" =~ ^[0-9a-f]{40}$ && "$master_sha" =~ ^[0-9a-f]{40}$ ]] || { fail_source 'SHA de checkout o master inválido'; return 1; }
  [[ "$checkout_sha" == "$master_sha" ]] || { fail_source 'el checkout no coincide con el master oficial actual'; return 1; }
}
```

### Pruebas locales del gate

```bash
FIXTURE_SHA=1111111111111111111111111111111111111111
OFFICIAL_HTTPS=https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend.git
OFFICIAL_SSH=git@github.com:Taller-SW-Web/G6-Productos-Ofertas-backend.git
validate_source_facts "$OFFICIAL_HTTPS" "$FIXTURE_SHA" reachable "$FIXTURE_SHA" clean
validate_source_facts "$OFFICIAL_SSH" "$FIXTURE_SHA" reachable "$FIXTURE_SHA" clean
printf 'PASS fixture: HTTPS y SSH oficiales con SHA coincidente aceptados\n'
if validate_source_facts https://github.com/fork/G6-Productos-Ofertas-backend.git "$FIXTURE_SHA" reachable "$FIXTURE_SHA" clean; then exit 1; else printf 'PASS fixture: fork rechazado\n'; fi
if validate_source_facts "$OFFICIAL_HTTPS" "$FIXTURE_SHA" reachable 2222222222222222222222222222222222222222 clean; then exit 1; else printf 'PASS fixture: SHA obsoleto rechazado\n'; fi
if validate_source_facts "$OFFICIAL_HTTPS" "$FIXTURE_SHA" unreachable '' clean; then exit 1; else printf 'PASS fixture: referencia inaccesible rechazada\n'; fi
if validate_source_facts "$OFFICIAL_HTTPS" "$FIXTURE_SHA" reachable "$FIXTURE_SHA" dirty; then exit 1; else printf 'PASS fixture: checkout modificado rechazado\n'; fi
```

## Preflight y exclusión

El ejecutor usa flock por servicio, pero no implementa un bloqueo global de instalación. Suspender CI/CD Oracle y lanzamientos manuales, confirmar que no hay procesos deploy-g6-service ni deploy-inventory-svc activos y mantener la suspensión hasta completar o restaurar. Si no se garantiza esa exclusión, detenerse.

```bash
set -Eeuo pipefail
cd /RUTA/AL/CHECKOUT_AUTORIZADO
git status --short --branch
verify_official_master() {
  local fetch_text push_text url transport status_output checkout_sha ref_output master_sha
  local -a fetch_urls=() push_urls=() refs=()
  fetch_text="$(git remote get-url --all origin)" || { fail_source 'no se pudo resolver la URL fetch de origin'; return 1; }
  push_text="$(git remote get-url --push --all origin)" || { fail_source 'no se pudo resolver la URL push de origin'; return 1; }
  mapfile -t fetch_urls <<<"$fetch_text"
  mapfile -t push_urls <<<"$push_text"
  [[ "${#fetch_urls[@]}" == 1 && -n "${fetch_urls[0]}" ]] || { fail_source 'origin debe tener exactamente una URL fetch'; return 1; }
  [[ "${#push_urls[@]}" == 1 && "${push_urls[0]}" == "${fetch_urls[0]}" ]] || { fail_source 'origin fetch y push deben apuntar a la misma URL oficial'; return 1; }
  url="${fetch_urls[0]}"
  is_authorized_repository_url "$url" || { fail_source 'origin no apunta al repositorio oficial permitido'; return 1; }
  case "$url" in
    https://*) transport=https ;;
    *) transport=ssh ;;
  esac
  status_output="$(git status --porcelain --untracked-files=all)" || { fail_source 'no se pudo comprobar el estado del checkout'; return 1; }
  [[ -z "$status_output" ]] || { fail_source 'el checkout tiene modificaciones locales'; return 1; }
  checkout_sha="$(git rev-parse --verify 'HEAD^{commit}')" || { fail_source 'no se pudo resolver HEAD del checkout'; return 1; }
  if [[ "$transport" == https ]]; then
    ref_output="$(git -c http.sslVerify=true ls-remote "$url" refs/heads/master)" || { fail_source 'no se pudo consultar master por HTTPS verificado'; return 1; }
  else
    ref_output="$(GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' git ls-remote "$url" refs/heads/master)" || { fail_source 'no se pudo consultar master por SSH con host key verificada'; return 1; }
  fi
  mapfile -t refs <<<"$ref_output"
  [[ "${#refs[@]}" == 1 && "${refs[0]}" =~ ^([0-9a-f]{40})[[:space:]]refs/heads/master$ ]] || { fail_source 'la referencia remota master falta o su respuesta es ambigua'; return 1; }
  master_sha="${BASH_REMATCH[1]}"
  validate_source_facts "$url" "$checkout_sha" reachable "$master_sha" clean || return 1
  printf '%s\n' "$checkout_sha"
}
INSTALL_SHA="$(verify_official_master)"
printf 'Repositorio oficial y master verificados: %s\n' "$INSTALL_SHA"
sha256sum ops/oracle/service-registry.sh ops/oracle/services.psv \
  ops/oracle/deploy-g6-service.sh ops/oracle/deploy-inventory-svc.sh \
  ops/oracle/docker-compose.service.yml ops/oracle/docker-compose.service.http.yml \
  ops/oracle/docker-compose.gateway.yml ops/oracle/docker-compose.inventory.http.yml
```

Si falla cualquier comprobación, detenerse. Registrar SHA, fecha y checksums.

## Respaldo recuperable

No leer ni imprimir runtime.env. Registrar dueño, grupo, modo, timestamp, tamaño y checksum de destinos existentes. cp --archive conserva contenido y metadata.

```bash
DESTINOS=(/usr/local/lib/g6-productos-ofertas/service-registry.sh /usr/local/lib/g6-productos-ofertas/services.psv /usr/local/lib/g6-productos-ofertas/deploy-g6-service /opt/g6-productos-ofertas/shared/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml /usr/local/sbin/deploy-inventory-svc)
sudo stat --format='%n|%U:%G|%a|%y|%s' "${DESTINOS[@]}" 2>&1 || true
sudo sha256sum "${DESTINOS[@]}" 2>&1 || true
BACKUP_PARENT=/var/backups/g6-productos-ofertas
sudo test ! -L "$BACKUP_PARENT" || { printf 'FALLO: el padre del respaldo no puede ser symlink\n' >&2; exit 1; }
sudo install --directory --owner root --group root --mode 0755 "$BACKUP_PARENT"
sudo test ! -L "$BACKUP_PARENT" || { printf 'FALLO: el padre del respaldo no puede ser symlink\n' >&2; exit 1; }
IFS='|' read -r backup_parent_owner backup_parent_mode < <(sudo stat --format='%U:%G|%a' "$BACKUP_PARENT")
[[ "$backup_parent_owner" == root:root && "$backup_parent_mode" == 755 ]] || { printf 'FALLO: el padre del respaldo no está controlado por root\n' >&2; exit 1; }
BACKUP="$(sudo mktemp -d "$BACKUP_PARENT/h4.XXXXXXXXXX")" || { printf 'FALLO: no se pudo crear un respaldo exclusivo\n' >&2; exit 1; }
sudo chmod 0700 "$BACKUP"
IFS='|' read -r backup_owner backup_mode < <(sudo stat --format='%U:%G|%a' "$BACKUP")
[[ "$backup_owner" == root:root && "$backup_mode" == 700 ]] || { printf 'FALLO: el directorio de respaldo no es privado y root-owned\n' >&2; exit 1; }
sudo bash -c 'set -o noclobber; : > "$1"' _ "$BACKUP/destinos.tsv" || { printf 'FALLO: destinos.tsv ya existe o no se puede crear en respaldo nuevo\n' >&2; exit 1; }
for path in "${DESTINOS[@]}"; do
  name="$(printf '%s' "$path" | sed 's#^/##; s#/#__#g')"
  if sudo test -e "$path"; then
    sudo test -f "$path" && ! sudo test -L "$path" || { printf 'FALLO: destino no regular o symlink: %s\n' "$path" >&2; exit 1; }
    before_sha="$(sudo sha256sum -- "$path" | awk '{print $1}')"
    IFS='|' read -r before_owner before_mode before_time before_size < <(sudo stat --format='%U:%G|%a|%y|%s' "$path")
    printf '%s|existia|%s|%s|%s|%s|%s|%s\n' "$path" "$name" "$before_sha" "$before_owner" "$before_mode" "$before_time" "$before_size" | sudo tee -a "$BACKUP/destinos.tsv" >/dev/null
    sudo cp --archive -- "$path" "$BACKUP/$name"
  else
    printf '%s|ausente||||||\n' "$path" | sudo tee -a "$BACKUP/destinos.tsv" >/dev/null
  fi
done
sudo find "$BACKUP" -maxdepth 1 -type f -exec stat --format='%n|%U:%G|%a|%y|%s' {} \;
sudo bash -c 'shopt -s nullglob; files=("$1"/*); (("${#files[@]}" > 0)) && sha256sum -- "${files[@]}"' _ "$BACKUP"
```

El wildcard se expande dentro de sudo bash, con permisos root. Guardar ruta, metadata y hashes del respaldo como evidencia.

## Candidatos y validación antes de promover

Crear candidatos .new junto a cada destino, en el mismo filesystem. No reemplazar activos todavía. Verificar el SHA-256 completo de cada candidato contra el checkout y repetir la comparación justo antes de promover.

```bash
sudo install -d -o root -g root -m 0755 /usr/local/lib/g6-productos-ofertas /opt/g6-productos-ofertas/shared /opt/g6-productos-ofertas/api-gateway /opt/g6-productos-ofertas/inventory
sudo install -o root -g root -m 0644 ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh.new
sudo install -o root -g root -m 0644 ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv.new
sudo install -o root -g root -m 0755 ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.service.http.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.gateway.yml /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.inventory.http.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new
check_candidate() {
  local source="$1" candidate="$2" expected actual
  expected="$(sha256sum "$source" | awk '{print $1}')"
  actual="$(sudo sha256sum "$candidate" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]]
}
check_candidate ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh.new
check_candidate ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv.new
check_candidate ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service.new
check_candidate ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml.new
check_candidate ops/oracle/docker-compose.service.http.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new
check_candidate ops/oracle/docker-compose.gateway.yml /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new
check_candidate ops/oracle/docker-compose.inventory.http.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new
```

Instalar el candidato del overlay Inventory solo tras autorización operativa específica para ese cambio. El paso de staging no sustituye validación ni aprobación.

El shim Inventory también se prepara únicamente después de aprobación para su cambio:

```bash
sudo install -o root -g root -m 0755 ops/oracle/deploy-inventory-svc.sh /usr/local/sbin/deploy-inventory-svc.new
sudo grep -F '/usr/local/lib/g6-productos-ofertas/deploy-g6-service' /usr/local/sbin/deploy-inventory-svc.new
```

Validar Compose candidato antes de reemplazar archivos activos. Usar env files temporales sin secretos, imagen SHA fixture y docker compose config --format json. Revisar JSON con jq: exactamente nueve identidades/puertos, publicaciones solo en 127.0.0.1, Gateway como único G6 en g6-edge, ocho aliases autorizados en g6-http, RabbitMQ fuera de g6-http, e Inventory con Compose, proyecto, servicio y puerto históricos. No usar up, pull ni crear redes.

```bash
FIXTURE="$(mktemp)"
INVENTORY_FIXTURE="$(mktemp)"
INVENTORY_CANDIDATE="$(mktemp --suffix=.yml)"
trap 'rm -f "$FIXTURE" "$INVENTORY_FIXTURE" "$INVENTORY_CANDIDATE"' EXIT
SHA_FIXTURE="$(printf 'a%.0s' {1..40})"
for service in api-gateway bulk-svc catalog-svc combos-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc; do
  IFS='|' read -r _ _ port port_env _ _ _ _ project _ container _ _ < <(awk -F'|' -v s="$service" '$1==s {print}' ops/oracle/services.psv)
  export G6_SERVICE_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/$service:$SHA_FIXTURE" G6_SERVICE_CONTAINER="$container" G6_SERVICE_PORT="$port" G6_SERVICE_PORT_ENV="$port_env" G6_SERVICE_IMAGE_NAME="$service" G6_SERVICE_ENV_FILE="$FIXTURE"
  if [[ "$service" == api-gateway ]]; then base=/opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new; else base=/opt/g6-productos-ofertas/shared/docker-compose.service.yml.new; fi
  docker compose --project-name "$project" --file "$base" config --format json | jq -e '.services | length == 1' >/dev/null
  docker compose --project-name "$project" --file "$base" --file /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new config --format json | jq -e '.services | length == 1' >/dev/null
done
sed "s|/etc/g6-inventory/runtime.env|$INVENTORY_FIXTURE|" docker-compose.inventory.yml > "$INVENTORY_CANDIDATE"
export INVENTORY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:$SHA_FIXTURE"
docker compose --project-name g6-inventory --file "$INVENTORY_CANDIDATE" config --format json | jq -e '.name == "g6-inventory"' >/dev/null
docker compose --project-name g6-inventory --file "$INVENTORY_CANDIDATE" --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new config --format json | jq -e '.services["inventory-svc"].ports[0].host_ip == "127.0.0.1" and .services["inventory-svc"].ports[0].published == "3005"' >/dev/null
```

Las aserciones del ejemplo son un mínimo; revisar la salida JSON completa. config no inicia contenedores ni crea redes.

## Promoción ordenada y rollback

Mantener congelados CI/CD y lanzamientos manuales; confirmar otra vez que no hay ejecutores activos. Promover con mv --no-target-directory, siempre en el mismo filesystem y verificando cada checksum antes y después: Compose genérico y Gateway; overlay genérico; registro; ejecutor; y shim Inventory al final. El overlay Inventory solo con su validación y autorización operativa propia. Esta guía no cambia Inventory ni Caddy; ambos requieren validaciones y autorización operativa separadas.

La función check_candidate del paso anterior se vuelve a ejecutar inmediatamente antes de cada promoción. No continuar si cualquier comparación falla.

```bash
check_candidate() {
  local source="$1" candidate="$2" expected actual
  expected="$(sha256sum "$source" | awk '{print $1}')"
  actual="$(sudo sha256sum "$candidate" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]]
}
authorized_destination() {
  case "$1" in
    /usr/local/lib/g6-productos-ofertas/service-registry.sh|/usr/local/lib/g6-productos-ofertas/services.psv|/usr/local/lib/g6-productos-ofertas/deploy-g6-service|/opt/g6-productos-ofertas/shared/docker-compose.service.yml|/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml|/opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml|/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml|/usr/local/sbin/deploy-inventory-svc) return 0 ;;
    *) return 1 ;;
  esac
}
declare -gA DESTINO_STATE=() DESTINO_BACKUP=() DESTINO_SHA=() DESTINO_OWNER=() DESTINO_MODE=() DESTINO_TIME=() DESTINO_SIZE=()
declare -ga PROMOTION_DESTINATIONS=()
declare -gA PROMOTION_INSTALLED_SHA=() PROMOTION_OWNER=() PROMOTION_MODE=() PROMOTION_TIME=() PROMOTION_SIZE=()
load_destination_manifest() {
  local manifest_text row destination state backup_name sha owner mode timestamp size extra separators count=0 expected
  local -A seen=()
  local destination_file="$BACKUP/destinos.tsv"
  sudo test -f "$destination_file" && ! sudo test -L "$destination_file" || { fail_source 'destinos.tsv falta o no es archivo regular'; return 1; }
  manifest_text="$(sudo cat -- "$destination_file")" || { fail_source 'no se pudo leer completo destinos.tsv'; return 1; }
  [[ -n "$manifest_text" ]] || { fail_source 'destinos.tsv está vacío o mal formado'; return 1; }
  DESTINO_STATE=() DESTINO_BACKUP=() DESTINO_SHA=() DESTINO_OWNER=() DESTINO_MODE=() DESTINO_TIME=() DESTINO_SIZE=()
  while IFS= read -r row || [[ -n "$row" ]]; do
    separators="${row//[^|]/}"
    [[ "${#separators}" == 7 ]] || { fail_source 'fila de destinos.tsv mal formada'; return 1; }
    IFS='|' read -r destination state backup_name sha owner mode timestamp size extra <<< "$row"
    authorized_destination "$destination" || { fail_source "destino desconocido en destinos.tsv: $destination"; return 1; }
    [[ -z "${seen[$destination]+present}" ]] || { fail_source "destino duplicado en destinos.tsv: $destination"; return 1; }
    seen[$destination]=1
    [[ -z "$extra" ]] || { fail_source "columnas adicionales en destinos.tsv: $destination"; return 1; }
    if [[ "$state" == existia ]]; then
      [[ "$backup_name" =~ ^[A-Za-z0-9_.-]+$ && "$sha" =~ ^[0-9a-f]{64}$ && "$owner" =~ ^[^|]+:[^|]+$ && "$mode" =~ ^[0-7]{3,4}$ && "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[[:space:]][+-][0-9]{4}$ && "$size" =~ ^[0-9]+$ ]] || { fail_source "metadata inicial inválida en destinos.tsv: $destination"; return 1; }
    elif [[ "$state" == ausente ]]; then
      [[ -z "$backup_name$sha$owner$mode$timestamp$size" ]] || { fail_source "campos inesperados para destino ausente: $destination"; return 1; }
    else
      fail_source "estado inicial inválido en destinos.tsv: $destination"; return 1
    fi
    DESTINO_STATE[$destination]="$state"
    DESTINO_BACKUP[$destination]="$backup_name"
    DESTINO_SHA[$destination]="$sha"
    DESTINO_OWNER[$destination]="$owner"
    DESTINO_MODE[$destination]="$mode"
    DESTINO_TIME[$destination]="$timestamp"
    DESTINO_SIZE[$destination]="$size"
    ((count += 1))
  done <<< "$manifest_text"
  [[ "$count" == "${#DESTINOS[@]}" ]] || { fail_source 'destinos.tsv no contiene exactamente la lista autorizada'; return 1; }
  for expected in "${DESTINOS[@]}"; do
    [[ -n "${seen[$expected]+present}" ]] || { fail_source "destinos.tsv no registra $expected"; return 1; }
  done
}
check_candidate() {
  local source="$1" candidate="$2" expected actual
  expected="$(sha256sum "$source" | awk '{print $1}')"
  actual="$(sudo sha256sum "$candidate" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]]
}
record_promotion() {
  local destination="$1" installed_sha="$2" installed_stat
  installed_stat="$(sudo stat --format='%U:%G|%a|%y|%s' "$destination")" || { fail_source "no se pudo registrar metadata instalada: $destination"; return 1; }
  printf '%s|%s|%s\n' "$destination" "$installed_sha" "$installed_stat" | sudo tee -a "$BACKUP/promovidos.tsv" >/dev/null || { fail_source "no se pudo registrar promoción: $destination"; return 1; }
}
promote_candidate() {
  local source="$1" candidate="$2" destination="$3" state current_sha current_stat source_sha installed_sha
  authorized_destination "$destination" || { fail_source "destino no autorizado: $destination"; return 1; }
  load_destination_manifest || return 1
  state="${DESTINO_STATE[$destination]:-}"
  [[ -n "$state" ]] || { fail_source "destino no tiene exactamente una entrada inicial: $destination"; return 1; }
  if [[ "$state" == existia ]]; then
    sudo test -f "$destination" && ! sudo test -L "$destination" || { fail_source "destino existente cambió de tipo: $destination"; return 1; }
    current_sha="$(sudo sha256sum -- "$destination" | awk '{print $1}')" || { fail_source "no se pudo comprobar destino: $destination"; return 1; }
    current_stat="$(sudo stat --format='%U:%G|%a|%y|%s' "$destination")" || { fail_source "no se pudo leer metadata del destino: $destination"; return 1; }
    [[ "$current_sha" == "${DESTINO_SHA[$destination]}" && "$current_stat" == "${DESTINO_OWNER[$destination]}|${DESTINO_MODE[$destination]}|${DESTINO_TIME[$destination]}|${DESTINO_SIZE[$destination]}" ]] || { fail_source "destino existente cambió desde el respaldo: $destination"; return 1; }
  else
    sudo test ! -e "$destination" && sudo test ! -L "$destination" || { fail_source "destino originalmente ausente apareció antes de promoción: $destination"; return 1; }
  fi
  source_sha="$(sha256sum "$source" | awk '{print $1}')" || { fail_source "no se pudo calcular SHA-256 fuente: $source"; return 1; }
  check_candidate "$source" "$candidate" || { fail_source "checksum del candidato cambió: $candidate"; return 1; }
  sudo mv --no-target-directory -- "$candidate" "$destination" || { fail_source "no se pudo renombrar candidato: $destination"; return 1; }
  installed_sha="$(sudo sha256sum -- "$destination" | awk '{print $1}')" || { fail_source "no se pudo verificar contenido instalado: $destination"; return 1; }
  [[ "$installed_sha" == "$source_sha" ]] || { fail_source "el contenido instalado no coincide con el SHA-256 fuente aprobada: $destination; mantener despliegues congelados y conciliar antes de continuar"; return 1; }
  record_promotion "$destination" "$installed_sha"
}
PROMOTION_SHA="$(verify_official_master)"
[[ "$PROMOTION_SHA" == "$INSTALL_SHA" ]] || fail_source 'master oficial cambió desde el preflight; no se promueve ningún archivo'
sudo bash -c 'set -o noclobber; : > "$1"' _ "$BACKUP/promovidos.tsv" || { printf 'FALLO: promovidos.tsv ya existe o no se puede crear en respaldo nuevo\n' >&2; exit 1; }
# Orden fijo: Compose genérico, Gateway, overlay genérico, registro y ejecutor.
promote_candidate ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml.new /opt/g6-productos-ofertas/shared/docker-compose.service.yml
promote_candidate ops/oracle/docker-compose.gateway.yml /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml
promote_candidate ops/oracle/docker-compose.service.http.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml
promote_candidate ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv.new /usr/local/lib/g6-productos-ofertas/services.psv
promote_candidate ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh.new /usr/local/lib/g6-productos-ofertas/service-registry.sh
promote_candidate ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service.new /usr/local/lib/g6-productos-ofertas/deploy-g6-service
# Solo tras autorización, validación y promoción separada del overlay Inventory:
# promote_candidate ops/oracle/docker-compose.inventory.http.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml
# Solo tras autorización y validación específica del shim Inventory:
# promote_candidate ops/oracle/deploy-inventory-svc.sh /usr/local/sbin/deploy-inventory-svc.new /usr/local/sbin/deploy-inventory-svc
```

Ante cualquier fallo, mantener congelados despliegues y recuperar **solo** los destinos registrados en `promovidos.tsv`, en orden inverso. La tabla `destinos.tsv`, escrita antes del staging, marca si cada destino existía originalmente y conserva nombre de respaldo, checksum, propietario/grupo, permisos, timestamp y tamaño. Cada promoción se registra con su checksum y metadata instalados. Si la secuencia se interrumpe entre el renombre y el registro de promoción, detenerse: conciliar manualmente ese único destino con evidencia; no adivinar ni reanudar.

El ejemplo siguiente falla cerrado ante destinos fuera de la lista, metadatos faltantes, cambios posteriores o discrepancias. Para un archivo originalmente existente, compara primero el destino con el estado instalado y solo entonces copia el respaldo a un temporal hermano y lo renombra atómicamente. Para uno originalmente ausente, retira solo el archivo exacto, únicamente si checksum y metadata siguen idénticos al estado recién promovido. Un destino no promovido no se toca. Al finalizar compara checksum y metadata restaurados contra el inventario original. No reanudar despliegues si recuperación, verificaciones o validación Compose fallan.

```bash
load_promotion_manifest() {
  local promotion_file="$BACKUP/promovidos.tsv" promotion_text row destination sha owner mode timestamp size extra separators
  local -A seen=()
  sudo test -f "$promotion_file" && ! sudo test -L "$promotion_file" || { fail_source 'promovidos.tsv falta o no es archivo regular'; return 1; }
  promotion_text="$(sudo cat -- "$promotion_file")" || { fail_source 'no se pudo leer completo promovidos.tsv'; return 1; }
  PROMOTION_DESTINATIONS=() PROMOTION_INSTALLED_SHA=() PROMOTION_OWNER=() PROMOTION_MODE=() PROMOTION_TIME=() PROMOTION_SIZE=()
  # Archivo regular leído con éxito y vacío significa que todavía no se promovió ningún destino.
  [[ -n "$promotion_text" ]] || return 0
  while IFS= read -r row || [[ -n "$row" ]]; do
    separators="${row//[^|]/}"
    [[ "${#separators}" == 5 ]] || { fail_source 'fila de promovidos.tsv mal formada'; return 1; }
    IFS='|' read -r destination sha owner mode timestamp size extra <<< "$row"
    authorized_destination "$destination" || { fail_source "destino desconocido en promovidos.tsv: $destination"; return 1; }
    [[ -z "${seen[$destination]+present}" ]] || { fail_source "destino duplicado en promovidos.tsv: $destination"; return 1; }
    seen[$destination]=1
    [[ -n "${DESTINO_STATE[$destination]+present}" && -z "$extra" && "$sha" =~ ^[0-9a-f]{64}$ && "$owner" =~ ^[^|]+:[^|]+$ && "$mode" =~ ^[0-7]{3,4}$ && "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[[:space:]][+-][0-9]{4}$ && "$size" =~ ^[0-9]+$ ]] || { fail_source "registro de promoción inconsistente: $destination"; return 1; }
    PROMOTION_DESTINATIONS+=("$destination")
    PROMOTION_INSTALLED_SHA[$destination]="$sha"
    PROMOTION_OWNER[$destination]="$owner"
    PROMOTION_MODE[$destination]="$mode"
    PROMOTION_TIME[$destination]="$timestamp"
    PROMOTION_SIZE[$destination]="$size"
  done <<< "$promotion_text"
}
rollback_promotions() {
  local i destination original_state backup_name original_sha original_owner original_mode original_time original_size
  local installed_sha installed_owner installed_mode installed_time installed_size current_sha current_stat restore_path restore_sha restore_stat restored_sha restored_stat
  load_destination_manifest || return 1
  load_promotion_manifest || return 1
  for ((i=${#PROMOTION_DESTINATIONS[@]}-1; i>=0; i--)); do
    destination="${PROMOTION_DESTINATIONS[i]}"
    original_state="${DESTINO_STATE[$destination]}"
    backup_name="${DESTINO_BACKUP[$destination]}"
    original_sha="${DESTINO_SHA[$destination]}"
    original_owner="${DESTINO_OWNER[$destination]}"
    original_mode="${DESTINO_MODE[$destination]}"
    original_time="${DESTINO_TIME[$destination]}"
    original_size="${DESTINO_SIZE[$destination]}"
    installed_sha="${PROMOTION_INSTALLED_SHA[$destination]}"
    installed_owner="${PROMOTION_OWNER[$destination]}"
    installed_mode="${PROMOTION_MODE[$destination]}"
    installed_time="${PROMOTION_TIME[$destination]}"
    installed_size="${PROMOTION_SIZE[$destination]}"
    sudo test -f "$destination" && ! sudo test -L "$destination" || { printf 'CONFLICTO: destino promovido falta o cambió de tipo: %s\n' "$destination" >&2; return 1; }
    current_sha="$(sudo sha256sum -- "$destination" | awk '{print $1}')" || { printf 'CONFLICTO: no se pudo comprobar destino %s\n' "$destination" >&2; return 1; }
    current_stat="$(sudo stat --format='%U:%G|%a|%y|%s' "$destination")" || { printf 'CONFLICTO: no se pudo leer metadata de %s\n' "$destination" >&2; return 1; }
    [[ "$current_sha" == "$installed_sha" && "$current_stat" == "$installed_owner|$installed_mode|$installed_time|$installed_size" ]] || {
      printf 'CONFLICTO: %s cambió después de la promoción; no se modifica\n' "$destination" >&2; return 1;
    }
    if [[ "$original_state" == existia ]]; then
      restore_path="${destination}.rollback.$$"
      sudo test ! -e "$restore_path" && sudo test ! -L "$restore_path" || { printf 'CONFLICTO: temporal ya existe: %s\n' "$restore_path" >&2; return 1; }
      sudo test -f "$BACKUP/$backup_name" && ! sudo test -L "$BACKUP/$backup_name" || { printf 'CONFLICTO: respaldo falta o no es regular: %s\n' "$backup_name" >&2; return 1; }
      sudo cp --archive -- "$BACKUP/$backup_name" "$restore_path"
      restore_sha="$(sudo sha256sum -- "$restore_path" | awk '{print $1}')"
      restore_stat="$(sudo stat --format='%U:%G|%a|%y|%s' "$restore_path")"
      [[ "$restore_sha" == "$original_sha" && "$restore_stat" == "$original_owner|$original_mode|$original_time|$original_size" ]] || {
        printf 'CONFLICTO: copia temporal no coincide con respaldo/inventario: %s\n' "$destination" >&2; sudo rm -- "$restore_path"; return 1;
      }
      sudo mv --no-target-directory -- "$restore_path" "$destination"
      restored_sha="$(sudo sha256sum -- "$destination" | awk '{print $1}')"
      restored_stat="$(sudo stat --format='%U:%G|%a|%y|%s' "$destination")"
      [[ "$restored_sha" == "$original_sha" && "$restored_stat" == "$original_owner|$original_mode|$original_time|$original_size" ]] || {
        printf 'FALLO: restauración no coincide con respaldo/inventario: %s\n' "$destination" >&2; return 1;
      }
    elif [[ "$original_state" == ausente ]]; then
      sudo rm -- "$destination"
      sudo test ! -e "$destination" && sudo test ! -L "$destination" || { printf 'FALLO: no se retiró exactamente el archivo creado %s\n' "$destination" >&2; return 1; }
    else
      printf 'CONFLICTO: estado original inválido para %s\n' "$destination" >&2; return 1
    fi
  done
  printf 'PASS: todos los destinos promovidos fueron recuperados y verificados\n'
}
rollback_promotions || { printf 'RECUPERACIÓN INCOMPLETA: mantener despliegues congelados y escalar el conflicto; no reanudar.\n' >&2; exit 1; }
# Revalidar los Compose restaurados con config --format json. No ejecutar up ni crear redes.
```

La función nunca procesa destinos que no figuran en el log de promoción. Conserva Inventory histórico y no toca runtime.env, certificados, active-image, previous-image, imágenes, contenedores ni redes. No borrar directorios ni aplicar comandos destructivos globales.

Registrar SHA remoto, hashes antes/después, respaldo y resultados. No ejecutar SSH remoto, CD, up, pull, probes contra Oracle ni cambios globales. Esta guía no acredita despliegue, readiness ni autorización de producción.
