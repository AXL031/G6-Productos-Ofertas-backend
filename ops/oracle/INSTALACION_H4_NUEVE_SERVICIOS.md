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
BACKUP="/var/backups/g6-productos-ofertas/h4-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install --directory --owner root --group root --mode 0700 "$BACKUP"
for path in "${DESTINOS[@]}"; do
  if sudo test -e "$path"; then
    name="$(printf '%s' "$path" | sed 's#^/##; s#/#__#g')"
    sudo cp --archive -- "$path" "$BACKUP/$name"
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
PROMOTION_SHA="$(verify_official_master)"
[[ "$PROMOTION_SHA" == "$INSTALL_SHA" ]] || fail_source 'master oficial cambió desde el preflight; no se promueve ningún archivo'
check_candidate ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml.new
sudo mv --no-target-directory /opt/g6-productos-ofertas/shared/docker-compose.service.yml.new /opt/g6-productos-ofertas/shared/docker-compose.service.yml
check_candidate ops/oracle/docker-compose.gateway.yml /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new
sudo mv --no-target-directory /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml
check_candidate ops/oracle/docker-compose.service.http.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new
sudo mv --no-target-directory /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml
check_candidate ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv.new
sudo mv --no-target-directory /usr/local/lib/g6-productos-ofertas/services.psv.new /usr/local/lib/g6-productos-ofertas/services.psv
check_candidate ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh.new
sudo mv --no-target-directory /usr/local/lib/g6-productos-ofertas/service-registry.sh.new /usr/local/lib/g6-productos-ofertas/service-registry.sh
check_candidate ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service.new
sudo mv --no-target-directory /usr/local/lib/g6-productos-ofertas/deploy-g6-service.new /usr/local/lib/g6-productos-ofertas/deploy-g6-service
# Solo tras autorización, validación y promoción separada del overlay Inventory:
check_candidate ops/oracle/docker-compose.inventory.http.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new
sudo mv --no-target-directory /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml
# Solo tras autorización y validación específica del shim Inventory:
check_candidate ops/oracle/deploy-inventory-svc.sh /usr/local/sbin/deploy-inventory-svc.new
sudo mv --no-target-directory /usr/local/sbin/deploy-inventory-svc.new /usr/local/sbin/deploy-inventory-svc
```

Ante cualquier fallo, detener la secuencia y mantener congelados despliegues. Para cada destino anotado como existente, restaurar solo su respaldo con metadata a un .restore junto al destino y renombrarlo atómicamente; no restaurar destinos que antes no existían. Comparar checksum, dueño, grupo, permisos y timestamp con el inventario. Revalidar Compose con config. No borrar directorios, imágenes, redes, datos o contenedores.

```bash
sudo cp --archive -- "$BACKUP/usr__local__lib__g6-productos-ofertas__service-registry.sh" /usr/local/lib/g6-productos-ofertas/service-registry.sh.restore
sudo mv --no-target-directory /usr/local/lib/g6-productos-ofertas/service-registry.sh.restore /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo sha256sum /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo stat --format='%n|%U:%G|%a|%y|%s' /usr/local/lib/g6-productos-ofertas/service-registry.sh
```

Registrar SHA remoto, hashes antes/después, respaldo y resultados. No ejecutar SSH remoto, CD, up, pull, probes contra Oracle ni cambios globales. Esta guía no acredita despliegue, readiness ni autorización de producción.
