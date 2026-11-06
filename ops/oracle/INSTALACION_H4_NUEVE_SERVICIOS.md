# Instalación futura del ejecutor Oracle v5 y la red HTTP

Procedimiento documental, reversible y sin arranque/despliegue. Codex no ejecuta estos comandos en Oracle. Aplicar solo con autorización operativa, en el checkout autorizado y tras revisar su SHA. No cambia secretos, `active-image`, `previous-image` ni `runtime.env`; no altera `authorized_keys` ni habilita una shell general.

## Autorización de SHA de integración

La release puede provenir de `integracion/h4-fase1-completa`; no se exige que el checkout sea `origin/master`. El nombre de rama permitido es fijo y no se aceptan otras ramas ni SHA libres. Marco registra en Backend #111 una autorización individual que identifica el SHA de 40 caracteres, los nueve servicios, el resultado CI de ese SHA y el alcance de instalación. El operador verifica la autorización y su identidad GitHub antes de seguir. Una aprobación para otro SHA no sirve.

## Secuencia ejecutable

Detenerse ante cualquier error y guardar salidas sin valores secretos.

### 1. Preflight de versión y checksums

```bash
set -Eeuo pipefail
cd /RUTA/AL/CHECKOUT_AUTORIZADO
readonly RELEASE_BRANCH='integracion/h4-fase1-completa'
: "${AUTHORIZED_SHA:?Copiar el SHA exacto aprobado en Backend #111}"
: "${RELEASE_APPROVAL_ID:?Indicar el identificador de la autorización individual en Backend #111}"
[[ "$AUTHORIZED_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'AUTHORIZED_SHA debe tener 40 caracteres hexadecimales' >&2; exit 1; }
[[ "$RELEASE_APPROVAL_ID" =~ ^[0-9]+$ ]] || { echo 'RELEASE_APPROVAL_ID inválido' >&2; exit 1; }
test "$(git remote get-url origin)" = 'https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend.git'
test "$(gh api user --jq .login)" = 'mrcastilla8'
git fetch origin "refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH"
test "$(git rev-parse HEAD)" = "$AUTHORIZED_SHA"
git merge-base --is-ancestor "$AUTHORIZED_SHA" "origin/$RELEASE_BRANCH"
git show --no-patch --format='commit=%H%nsubject=%s%nauthor=%an <%ae>' "$AUTHORIZED_SHA"
# Comprobar manualmente que RELEASE_APPROVAL_ID en Backend #111 autoriza este
# mismo SHA y los nueve servicios; registrar el enlace y el login del aprobador.
gh api "repos/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/$RELEASE_APPROVAL_ID" --jq '{state, title, html_url}'
gh api "repos/Taller-SW-Web/G6-Productos-Ofertas-backend/commits/$AUTHORIZED_SHA/check-runs" --jq '[.check_runs[] | {name, status, conclusion}]'
git status --short --branch
sha256sum ops/oracle/service-registry.sh ops/oracle/services.psv \
  ops/oracle/deploy-g6-service.sh ops/oracle/deploy-inventory-svc.sh \
  ops/oracle/docker-compose.service.yml ops/oracle/docker-compose.service.http.yml \
  ops/oracle/docker-compose.gateway.yml ops/oracle/docker-compose.inventory.http.yml
```

Registrar SHA, ID de autorización, aprobador, checksums y estado de CI. Si el SHA dejó de estar contenido en la rama de integración, detenerse y solicitar una nueva autorización; no sustituirlo por otro SHA durante la instalación.

### 2. Inventariar destinos con stat y sha256sum

```bash
sudo stat --format='%n|%U:%G|%a|%y|%s' \
  /usr/local/lib/g6-productos-ofertas/service-registry.sh \
  /usr/local/lib/g6-productos-ofertas/services.psv \
  /usr/local/lib/g6-productos-ofertas/deploy-g6-service \
  /opt/g6-productos-ofertas/shared/docker-compose.service.yml \
  /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml \
  /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml \
  /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml \
  /usr/local/sbin/deploy-inventory-svc 2>&1 || true
sudo sha256sum \
  /usr/local/lib/g6-productos-ofertas/service-registry.sh \
  /usr/local/lib/g6-productos-ofertas/services.psv \
  /usr/local/lib/g6-productos-ofertas/deploy-g6-service \
  /opt/g6-productos-ofertas/shared/docker-compose.service.yml \
  /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml \
  /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml \
  /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml \
  /usr/local/sbin/deploy-inventory-svc 2>&1 || true
```

Registrar cada ruta existente/ausente. No leer ni imprimir ningún `runtime.env`.

### 3. Respaldar propietario, permisos y timestamps

```bash
BACKUP="/var/backups/g6-productos-ofertas/h4-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install --directory --owner root --group root --mode 0700 "$BACKUP"
for path in \
  /usr/local/lib/g6-productos-ofertas/service-registry.sh \
  /usr/local/lib/g6-productos-ofertas/services.psv \
  /usr/local/lib/g6-productos-ofertas/deploy-g6-service \
  /opt/g6-productos-ofertas/shared/docker-compose.service.yml \
  /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml \
  /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml \
  /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml \
  /usr/local/sbin/deploy-inventory-svc; do
  if sudo test -e "$path"; then
    name="$(printf '%s' "$path" | sed 's#^/##; s#/#__#g')"
    sudo cp --archive -- "$path" "$BACKUP/$name"
  fi
done
sudo find "$BACKUP" -maxdepth 1 -type f -exec stat --format='%n|%U:%G|%a|%y|%s' {} \;
sudo sha256sum "$BACKUP"/*
```

Guardar la ruta real de `BACKUP`, metadatos y checksums en el ticket. Exigir root:root 0700 para el directorio de respaldos.

### 4. Instalar copias candidatas en las rutas existentes

Los `.new` se crean junto a su destino para permitir renombre atómico. No ejecutar `compose up`, `pull`, reinicios, CD ni despliegues.

```bash
sudo install -d -o root -g root -m 0755 /usr/local/lib/g6-productos-ofertas /opt/g6-productos-ofertas/shared /opt/g6-productos-ofertas/api-gateway /opt/g6-productos-ofertas/inventory
sudo install -o root -g root -m 0644 ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh.new
sudo install -o root -g root -m 0644 ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv.new
sudo install -o root -g root -m 0755 ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.service.http.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.gateway.yml /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new
sudo install -o root -g root -m 0644 ops/oracle/docker-compose.inventory.http.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new
```

Comparar hashes de los `.new` con el paso 1. Aún no instalar el shim Inventory.

Tras confirmar checksums, instalar las definiciones Compose en sus destinos oficiales mediante renombre atómico:

```bash
sudo mv --no-target-directory /opt/g6-productos-ofertas/shared/docker-compose.service.yml.new /opt/g6-productos-ofertas/shared/docker-compose.service.yml
sudo mv --no-target-directory /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.new /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml
sudo mv --no-target-directory /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml.new /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml
sudo mv --no-target-directory /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml.new /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml
```

### 5. Validar ejecutor y registro

```bash
sudo install -o root -g root -m 0644 ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv
sudo install -o root -g root -m 0644 ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo install -o root -g root -m 0755 ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service
sudo -u inventory-deploy env -u SSH_ORIGINAL_COMMAND /usr/local/lib/g6-productos-ofertas/deploy-g6-service --version
sudo bash -c 'source /usr/local/lib/g6-productos-ofertas/service-registry.sh; g6_enabled_services_json'
```

Exigir `ejecutor=5 registro=2`, exactamente nueve servicios y los puertos del registro: Gateway 3000, Catalog 3001, Pricing 3002, Price Audit 3003, Promotions 3004, Inventory 3005, Taxonomy 3006, Combos 3007 y Bulk 3008.

### 6. Comprobar permisos de `inventory-deploy`

```bash
sudo -u inventory-deploy test -r /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo -u inventory-deploy test -r /usr/local/lib/g6-productos-ofertas/services.psv
sudo -u inventory-deploy test -x /usr/local/lib/g6-productos-ofertas/deploy-g6-service
```

### 7. Inspeccionar redes/aliases existentes antes de overlays

```bash
sudo docker network inspect g6-edge g6-http
sudo docker network inspect --format '{{range $id, $container := .Containers}}{{$container.Name}}{{"\n"}}{{end}}' g6-edge
sudo docker network inspect --format '{{range $id, $container := .Containers}}{{$container.Name}}{{"\n"}}{{end}}' g6-http
for container in $(sudo docker ps --filter network=g6-edge --format '{{.Names}}'); do sudo docker inspect --format '{{.Name}}|{{json .NetworkSettings.Networks}}' "$container"; done
for container in $(sudo docker ps --filter network=g6-http --format '{{.Names}}'); do sudo docker inspect --format '{{.Name}}|{{json .NetworkSettings.Networks}}' "$container"; done
```

Confirmar `g6-edge` solo con Caddy y Gateway, alias `g6-api-gateway`; `g6-http` debe ser bridge local, `Internal=false`, con aliases canónicos sin colisión y sin Caddy/RabbitMQ. Si redes, aliases o miembros difieren, detenerse y escalar; este procedimiento no crea ni reconfigura redes.

### 8. Validar Compose sin ejecutar `up`

Usar archivo de entorno vacío para interpolaciones y `env_file` temporal; no leer archivos privados. `SHA_FIXTURE` solo permite validar sintaxis, nunca ejecutar `pull`.

```bash
FIXTURE="$(mktemp)"
INVENTORY_COMPOSE="$(mktemp)"
trap 'rm -f "$FIXTURE" "$INVENTORY_COMPOSE"' EXIT
SHA_FIXTURE="$(printf 'a%.0s' {1..40})"
for service in api-gateway bulk-svc catalog-svc combos-svc price-audit-svc pricing-svc promotions-svc taxonomy-svc; do
  IFS='|' read -r _ _ port port_env _ _ image compose project unit container state runtime_env < <(awk -F'|' -v s="$service" '$1==s {print}' ops/oracle/services.psv)
  export G6_SERVICE_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/$service:$SHA_FIXTURE" G6_SERVICE_CONTAINER="$container" G6_SERVICE_PORT="$port" G6_SERVICE_PORT_ENV="$port_env" G6_SERVICE_IMAGE_NAME="$service" G6_SERVICE_ENV_FILE="$FIXTURE"
  if [[ "$service" == api-gateway ]]; then base=ops/oracle/docker-compose.gateway.yml; else base=ops/oracle/docker-compose.service.yml; fi
  docker compose --project-name "$project" --file "$base" config --quiet
  docker compose --project-name "$project" --file "$base" --file ops/oracle/docker-compose.service.http.yml config --quiet
done
sed "s|/etc/g6-inventory/runtime.env|$FIXTURE|" docker-compose.inventory.yml > "$INVENTORY_COMPOSE"
export INVENTORY_IMAGE="ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:$SHA_FIXTURE"
docker compose --project-name g6-inventory --file "$INVENTORY_COMPOSE" config --quiet
docker compose --project-name g6-inventory --file "$INVENTORY_COMPOSE" --file ops/oracle/docker-compose.inventory.http.yml config --quiet
```

Confirmar puertos 3000–3008 solo en `127.0.0.1`, Gateway único con `g6-edge`, ocho aliases HTTP en `g6-http`, e Inventory en su proyecto/Compose histórico. No utilizar `up`, `pull` ni iniciar servicios.

### 9. Instalar shim Inventory solo después de validar el ejecutor

```bash
sudo install -o root -g root -m 0755 ops/oracle/deploy-inventory-svc.sh /usr/local/sbin/deploy-inventory-svc.new
sudo grep -F '/usr/local/lib/g6-productos-ofertas/deploy-g6-service' /usr/local/sbin/deploy-inventory-svc.new
sudo mv --no-target-directory /usr/local/sbin/deploy-inventory-svc.new /usr/local/sbin/deploy-inventory-svc
```

### 10. Rechazar probes y comandos no autorizados

```bash
for remote in connectivity-probe 'id' 'service-deploy unknown 0000000000000000000000000000000000000000'; do
  if sudo -u inventory-deploy env SSH_ORIGINAL_COMMAND="$remote" /usr/local/sbin/deploy-inventory-svc; then
    echo 'FALLO: el wrapper aceptó un comando no autorizado' >&2; exit 1
  fi
done
```

Cada intento debe fallar con `comando remoto no autorizado`. No se usa SSH durante esta instalación documental.

### 11. Conservar el comando histórico Inventory

La invocación compatible es `inventory-deploy <SHA hexadecimal de 40 caracteres>`. Su forwarding al ejecutor se comprueba con `bash ops/oracle/tests/deploy-inventory-svc.test.sh` y `bash ops/oracle/tests/deploy-g6-service.test.sh` en el checkout. No ejecutar un SHA productivo como smoke.

### 12. Restaurar wrapper/archivos de forma atómica ante fallo

Restaurar primero el wrapper si fue sustituido y luego solo los destinos anotados como existentes. Ejemplo:

```bash
sudo cp --archive -- "$BACKUP/usr__local__sbin__deploy-inventory-svc" /usr/local/sbin/deploy-inventory-svc.restore
sudo mv --no-target-directory /usr/local/sbin/deploy-inventory-svc.restore /usr/local/sbin/deploy-inventory-svc
```

Repetir con el nombre respaldado correspondiente y el destino original. Si un archivo no existía antes, quitar únicamente el candidato instalado en esa ruta. No borrar directorios, secretos, datos, imágenes, redes o contenedores.

### 13. Verificar checksums posteriores

```bash
sudo sha256sum /usr/local/lib/g6-productos-ofertas/service-registry.sh /usr/local/lib/g6-productos-ofertas/services.psv /usr/local/lib/g6-productos-ofertas/deploy-g6-service /opt/g6-productos-ofertas/shared/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml /usr/local/sbin/deploy-inventory-svc
sudo stat --format='%n|%U:%G|%a|%y|%s' /usr/local/lib/g6-productos-ofertas/service-registry.sh /usr/local/lib/g6-productos-ofertas/services.psv /usr/local/lib/g6-productos-ofertas/deploy-g6-service /usr/local/sbin/deploy-inventory-svc
```

Comparar contra hashes del checkout o del respaldo utilizado; adjuntar permisos y timestamps al cierre.

### 14. Finalizar sin arrancar ni desplegar

Dejar archivos, respaldos y redes como están al terminar esta preparación. No arrancar contenedores ni ejecutar el CD. El despliegue posterior será individual y requerirá una ejecución manual autorizada cuyo SHA coincida con esta autorización. El workflow automático permanece limitado a `master`; esta rama no activa CD automático.

## Secuencia fija de liberación

Primer grupo: **Taxonomy → Catalog → Gateway**. Después: Pricing, Price Audit, Promotions, Inventory, Combos y Bulk según dependencias aprobadas; cada uno se instala mediante el mismo registro/ejecutor y no requiere cambios a Caddy.

Cambiar Caddy queda pendiente hasta que Gateway oficial esté desplegado, G7 real configurado, bypass demo desactivado, operaciones públicas no autorizadas denegadas, pruebas JWT válido/ausente/inválido/sin scope documentadas, Caddyfile previo respaldado y `caddy validate` pase. Una imagen aprobada no autoriza exposición pública. Docs mantiene cero operaciones `PUBLICA_APROBADA`.
