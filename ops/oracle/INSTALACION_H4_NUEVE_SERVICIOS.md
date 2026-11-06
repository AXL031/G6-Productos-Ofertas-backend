# Instalación documental del ejecutor Oracle v5 y topología HTTP

Procedimiento exclusivamente documental. No se ejecutó en Oracle. Requiere checkout autorizado, aprobación operativa específica y ventana de mantenimiento. No cambia imágenes activas, active-image, previous-image, runtime.env, secretos, Caddy ni redes productivas. No ejecutar up, pull, reinicios ni comandos destructivos globales.

## Preflight y exclusión

El ejecutor usa flock por servicio, pero no implementa un bloqueo global de instalación. Suspender CI/CD Oracle y lanzamientos manuales, confirmar que no hay procesos deploy-g6-service ni deploy-inventory-svc activos y mantener la suspensión hasta completar o restaurar. Si no se garantiza esa exclusión, detenerse.

```bash
set -Eeuo pipefail
cd /RUTA/AL/CHECKOUT_AUTORIZADO
git status --short --branch
test -z "$(git status --porcelain)"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_MASTER_SHA="$(git ls-remote origin refs/heads/master | awk 'NR==1 {print $1}')"
[[ "$REMOTE_MASTER_SHA" =~ ^[0-9a-f]{40}$ ]]
printf 'checkout=%s\norigin/master=%s\n' "$LOCAL_SHA" "$REMOTE_MASTER_SHA"
test "$LOCAL_SHA" = "$REMOTE_MASTER_SHA"
sha256sum ops/oracle/service-registry.sh ops/oracle/services.psv \
  ops/oracle/deploy-g6-service.sh ops/oracle/deploy-inventory-svc.sh \
  ops/oracle/docker-compose.service.yml ops/oracle/docker-compose.service.http.yml \
  ops/oracle/docker-compose.gateway.yml ops/oracle/docker-compose.inventory.http.yml
```

git ls-remote consulta master remoto actual; origin/master local no basta. Si los SHA difieren, detenerse y revisar el checkout vigente. Registrar SHA, fecha y checksums.

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
