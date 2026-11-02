# CD de servicios G6 en Oracle Cloud

> **Entrada para agentes:** antes de programar, seguir [`GUIA_DEVTEAM.md`](GUIA_DEVTEAM.md), leer [`CONTRATO_DESPLIEGUE.md`](CONTRATO_DESPLIEGUE.md) y la ficha del servicio asignado en [`servicios/`](servicios/). Este índice separa las reglas de desarrollo de los procedimientos de operación.

## Navegación rápida

| Necesidad | Documento |
|---|---|
| Estado de la VM (corte 19-oct-2026) | [`ESTADO_ACTUAL.md`](ESTADO_ACTUAL.md) |
| Preparar un servicio desde desarrollo | [`GUIA_DEVTEAM.md`](GUIA_DEVTEAM.md) |
| Política única de demo H4 y autenticación reversible | [H4-MODO-DEMO-AUTH-REVERSIBLE.md](H4-MODO-DEMO-AUTH-REVERSIBLE.md) |
| Requisitos comunes para build y runtime | [`CONTRATO_DESPLIEGUE.md`](CONTRATO_DESPLIEGUE.md) |
| Brechas específicas por servicio | [`servicios/`](servicios/) |
| Estado comparado por servicio y propuesta de gate CI | [`ESTADO_SERVICIOS.md`](ESTADO_SERVICIOS.md) |
| Esquemas/tablas Supabase observados y su límite de evidencia | [`SUPABASE_ESQUEMAS.md`](SUPABASE_ESQUEMAS.md) |
| Redes y dependencias | [`MATRIZ_DEPENDENCIAS.md`](MATRIZ_DEPENDENCIAS.md) |
| RabbitMQ | [`RABBITMQ_COMPATIBILIDAD.md`](RABBITMQ_COMPATIBILIDAD.md) |
| Gates y formato de entrega | [`CHECKLIST_PREDEPLOY.md`](CHECKLIST_PREDEPLOY.md) |
| Evidencia CI/CD de Hito 4 y migración del check requerido | [`CI-CD-HITO4.md`](CI-CD-HITO4.md) |
| Procedimientos CD, operación y rollback | Secciones posteriores de este README y scripts enlazados |
| Evidencia histórica | [`auditorias/README.md`](auditorias/README.md) |

El estado operativo es una observación fechada, no una garantía de que la VM siga igual. Preparar una imagen no autoriza un despliegue: selección y autorización se rigen por `services.psv`, `auto-release-authorization.psv` y los procedimientos de liberación.

> **Estado operativo vigente:** consultar [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md), sustentado por la auditoría SSH del 19 de octubre de 2026. Los reportes fechados dentro de `auditorias/` permanecen como evidencia histórica de su fecha de observación.

El CD publica imágenes etiquetadas por SHA en GHCR y despliega mediante SSH restringido. Si una etiqueta SHA ya existe, solo se reutiliza cuando coinciden el paquete del servicio, el repositorio fuente y la revisión; una imagen no verificable falla cerrada y nunca se sobrescribe. La concurrencia serializa los intentos por servicio. El manifiesto declarativo `ops/oracle/services.psv`, leído sin ejecutarlo por `ops/oracle/service-registry.sh`, contiene los nueve componentes del monorepo, sus puertos, rutas, imágenes, contenedores, estados y archivos privados de runtime. El PR #122 ya está integrado. La allowlist manual y la autorización automática son independientes: `ops/oracle/auto-release-authorization.psv` comienza con los nueve servicios deshabilitados y exige el ID de una liberación manual exitosa más una referencia de evidencia readiness/smoke funcional. Un nombre en `services.psv` nunca habilita despliegue automático.

## Estado y límites

- El PR #7 dejó instalado el comando SSH `/usr/local/sbin/deploy-inventory-svc` y el Compose `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml`. La ruta `inventory-deploy <SHA de 40 caracteres>` continúa aceptada como compatibilidad histórica de Inventory.
- El ejecutor común solo recibe un identificador del registro y un SHA hexadecimal de 40 caracteres. Rutas, imagen, proyecto Compose, contenedor, puerto y directorio de estado salen de valores constantes del registro. No acepta shell, rutas, nombre de contenedor ni destino como argumentos.
- `deploy-g6-service --version` informa `ejecutor=4 registro=2`; el ejecutor rechaza un registro cuya versión no está soportada. La versión 3 incorporó exclusión mutua por servicio con `flock`; la versión 4 agrega overlays optativos para `g6-http` sin cambiar el registro v2. La salida verifica versiones declaradas; los checksums de registro, manifiesto, ejecutor y Compose deben compararse con el commit revisado del PR.
- Cada servicio tiene un proyecto Compose, contenedor y directorio de estado propios. Las operaciones apuntan a un único servicio; no usan `down`, `--remove-orphans` ni cambian la configuración de RabbitMQ.
- El healthcheck confirma el proceso HTTP en `/health`. No acredita conectividad, credenciales o preparación de Supabase.
- No se ha desplegado en la VM ni configurado ningún secreto real como parte de este cambio.

## Controles de GitHub Actions

El workflow conserva `workflow_dispatch` manual en `master` con modos separados `deploy` y `connectivity-check`, y añade `workflow_run` después de completar CI. El modo de conectividad solo valida secretos, se une a Tailscale por OIDC, prueba ping/TCP/22, compara la clave ED25519 y autentica SSH estricto para ejecutar `connectivity-probe`; el wrapper debe rechazarlo. Ese job carece de permisos de publicación y Deployments y no alcanza `release`. El camino automático acepta exclusivamente el workflow `.github/workflows/ci.yml`, evento `push`, rama `master`, conclusión `success`, repositorio fuente igual al repositorio base y SHA de 40 caracteres que siga siendo la punta de `master`. Rechaza PRs, forks, otras ramas, otros workflows, fallos/cancelaciones y SHAs antiguos. El job de publicación vuelve a comprobar la punta antes de SSH. El selector manual consulta el manifiesto vigente `services.psv` (nueve filas); el automático consulta solo `auto-release-authorization.psv`. Una allowlist histórica de cuatro servicios aparece en el procedimiento de transición de Inventory más abajo y no describe ni limita el manifiesto actual.

Cada fila de la matriz es independiente y publica y despliega solo su servicio; un fallo de publicación no cancela las otras filas. Las filas usan `fail-fast: false` y un grupo de concurrencia común por repositorio y servicio para cada ejecución de CD. El ejecutor vuelve a serializar en Oracle mediante `flock` con un archivo dentro del directorio de estado propio del servicio; conserva el bloqueo durante despliegue y rollback, y falla cerrado si `flock` no está disponible. Así una operación no puede pisar sus archivos `active-image`/`previous-image` ni otro servicio. El job preparatorio tiene `actions: read`, `contents: read` y `deployments: read`; el job de publicación tiene `contents: read`, `packages: write`, `deployments: write` y `id-token: write`. Antes de publicar, Actions valida la presencia de secretos/variables, conecta el runner efímero a Tailscale mediante OIDC, exige que `ORACLE_HOST` sea un peer de la tailnet y verifica `known_hosts` y la clave SSH restringida. El host valida el servicio, el SHA, la imagen actual, el healthcheck de Docker y HTTP; si la versión nueva falla, restaura solo el servicio elegido.

## Historial de despliegue y recuperación

GitHub Deployments usa un entorno cerrado por servicio, `g6-oracle-<servicio>`, y la tarea `deploy`. El job crea un deployment en estado `in_progress` antes de SSH. Solo publica `success` cuando el comando remoto termina correctamente; el ejecutor solo devuelve éxito tras validar el healthcheck HTTP y de Docker. Un error de publicación no crea deployment. Un fallo de despliegue registra `failure` y un trabajo cancelado que no alcanza el paso final queda en estado no exitoso. Ninguno avanza el SHA exitoso.

### Registro en GitHub Deployments y ausencia de Environment job gate

GitHub Deployments utiliza entornos lógicos cerrados por servicio (`g6-oracle-<servicio>`) mediante llamadas a la API de Deployments (`ops/oracle/github-deployment-api.sh`).

**Aclaración normativa de auditoría:**
- **Los revisores de GitHub Environments no están configurados como gate del job en el workflow actual.** El job `release` no declara la directiva `environment:` en el YAML de GitHub Actions; por tanto, el workflow no se pausa en Actions a la espera de aprobaciones interactivas de revisores en la interfaz web de GitHub.
- El acceso SSH desde Actions requiere un runner efímero conectado a Tailscale mediante GitHub OIDC. El paso Tailscale está limitado a `tag:g6-deploy-actions`; el permiso de red debe conceder únicamente TCP/22 al nodo Oracle etiquetado. El OIDC se usa únicamente en el job de publicación/despliegue, con `id-token: write` limitado a ese job.
- No se debe documentar ni asumir que existe un gate activo de revisores obligatorios en Actions sin que exista la directiva correspondiente en el workflow.

### Despliegue manual conservado y modo automático desactivado

La tabla automática mantiene todos los componentes en `false`. Para habilitar uno en el futuro, una revisión aprobada debe registrar el ID de su Deployment manual exitoso y una URL HTTPS de evidencia readiness o smoke funcional aprobada. El Deployment conserva `workflow_dispatch` y el ID del run; el workflow vuelve a consultar el Deployment y exige que la ejecución fuente sea este workflow, `workflow_dispatch` en `master`, exitosa, del mismo repositorio y servicio, y que el SHA de esa ejecución coincida con el SHA propio del Deployment. Ese SHA histórico puede ser distinto del nuevo commit automático: este último se valida independientemente contra la punta de `master` y la CI exitosa. Un Deployment antiguo sin procedencia comprobable no sirve. `/health` por sí solo no es evidencia suficiente. Mientras no haya filas autorizadas, `workflow_run` termina con selección `[]` y no crea imágenes ni Deployments.

Para realizar un despliegue, el operador debe ejecutar explícitamente `workflow_dispatch` en modo `deploy` indicando un único servicio habilitado del registro. Cualquier nombre no registrado se rechaza inmediatamente (código 64). `connectivity-check` es independiente y nunca construye ni publica imágenes, crea Deployments o ejecuta Compose. El registro de los nueve no autoriza por sí mismo su liberación: cada servicio necesita runtime completo, imagen/CI del mismo SHA, readiness funcional y autorización individual.

### Reconciliar GitHub con el estado real de Oracle

1. Pausa cambios operativos del servicio y compara de forma solo lectura la imagen del contenedor y su archivo `active-image` con los deployments de `g6-oracle-<servicio>`. Para Inventario, las rutas y contenedor existentes siguen siendo `/var/lib/g6-inventory/active-image` y `g6-inventory-svc`. No edites `active-image`/`previous-image` ni alteres estados de GitHub para hacerlos coincidir.
2. Si Oracle tiene una imagen nueva sin deployment `success`, o GitHub dice `success` pero Oracle tiene otra imagen, el historial no representa de forma confiable el estado real. Verifica que la imagen actual pertenezca al repositorio y al nombre/SHA cerrados del servicio; si no coincide, el ejecutor la rechazará y se debe resolver la discrepancia antes de continuar. Con aprobación operativa para desplegar, ejecuta `workflow_dispatch` en `master` seleccionando ese servicio; exige CI exitoso para el SHA actual y deja que el workflow vuelva a desplegar, comprobar salud y registrar un nuevo éxito.
3. Si no hay autorización o credenciales para esa reconciliación, conserva el estado actual y no marques manualmente un deployment como exitoso. Un historial ausente, pendiente o ilegible impide registrar éxito en el historial de Deployments. Registra la discrepancia para revisión operativa.

La plantilla genérica fija `PORT` y la variable específica (`*_PORT`) al mismo puerto del registro; ambas variables explícitas de Compose prevalecen sobre `runtime.env`. El healthcheck de Compose y la publicación loopback usan el mismo puerto. Inventario mantiene `INVENTORY_SVC_PORT=3005` y añade `PORT=3005` a su Compose versionado; la ruta, el contenedor y el healthcheck existente siguen en 3005.

## Transición segura del wrapper de Inventario

El despliegue anterior debe permanecer disponible hasta completar todas las comprobaciones. Los comandos `sudo install` siguientes requieren aprobación operativa explícita para cambiar archivos privilegiados en Oracle; este PR y el CD no sincronizan ni instalan esos archivos. Ejecuta el procedimiento manual como administrador solo después de esa autorización. **No ejecutes `docker compose up`, `pull`, reinicios ni el comando de despliegue durante la instalación o verificación.**

### 1. Guardar una copia recuperable del mecanismo instalado

Comprueba primero la ruta y checksum actuales; la ruta del Compose debe seguir siendo la del PR #7:

```bash
sudo stat --format='%U:%G %a %n' /usr/local/sbin/deploy-inventory-svc /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
sudo sha256sum /usr/local/sbin/deploy-inventory-svc
sudo install --directory --owner root --group root --mode 0700 /var/backups/g6-productos-ofertas
sudo cp --preserve=mode,ownership,timestamps /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
sudo sha256sum /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
```

Confirma que ambos checksums coincidan antes de seguir. No muevas ni reemplaces el Compose o los archivos de `/etc/g6-inventory` y `/var/lib/g6-inventory` sin aprobación operativa. El Compose versionado ahora iguala `PORT` con `INVENTORY_SVC_PORT=3005`; para instalarlo en `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml`, respáldalo, compara el checksum, valida el archivo candidato con `docker compose config --quiet` y sustitúyelo atómicamente. Esa actualización no ejecuta `up`, `pull` ni reinicios y debe estar aprobada antes del próximo despliegue genérico de Inventario.

Antes de instalar, anota el SHA del checkout revisado del PR y sus checksums de `service-registry.sh`, `services.psv`, `deploy-g6-service.sh` y `docker-compose.service.yml`. Conserva esa evidencia junto con la aprobación operativa.

### 2. Instalar el registro y el ejecutor genérico en rutas nuevas

Desde el checkout revisado del PR:

```bash
sudo install --directory --owner root --group root --mode 0755 /usr/local/lib/g6-productos-ofertas
sudo install --owner root --group root --mode 0644 ops/oracle/service-registry.sh /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo install --owner root --group root --mode 0644 ops/oracle/services.psv /usr/local/lib/g6-productos-ofertas/services.psv
sudo install --owner root --group root --mode 0755 ops/oracle/deploy-g6-service.sh /usr/local/lib/g6-productos-ofertas/deploy-g6-service
sudo install --directory --owner root --group root --mode 0755 /opt/g6-productos-ofertas/shared
sudo install --owner root --group root --mode 0644 ops/oracle/docker-compose.service.yml /opt/g6-productos-ofertas/shared/docker-compose.service.yml
sudo sha256sum /usr/local/lib/g6-productos-ofertas/service-registry.sh /usr/local/lib/g6-productos-ofertas/services.psv /usr/local/lib/g6-productos-ofertas/deploy-g6-service /opt/g6-productos-ofertas/shared/docker-compose.service.yml
sudo -u inventory-deploy env -u SSH_ORIGINAL_COMMAND /usr/local/lib/g6-productos-ofertas/deploy-g6-service --version
```

Compara checksums contra el checkout revisado y exige la salida exacta `ejecutor=4 registro=2`. No continúes ante diferencias o versiones incompatibles. La versión 4 conserva `flock` y el estado privado por servicio; el bloqueo se mantiene durante pull, cambio de contenedor, comprobación de salud y rollback. No cambies la ruta de estado de Inventario.

Antes de cambiar el wrapper, inspecciona los servicios habilitados y verifica que coincidan con el registro aprobado, y valida el Compose actual sin imprimir secretos ni cambiar contenedores:

```bash
sudo bash -c 'source /usr/local/lib/g6-productos-ofertas/service-registry.sh; g6_enabled_services_json'
sudo -u inventory-deploy test -r /usr/local/lib/g6-productos-ofertas/service-registry.sh
sudo -u inventory-deploy test -x /usr/local/lib/g6-productos-ofertas/deploy-g6-service
sudo -u inventory-deploy test -r /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
sudo -u inventory-deploy test -r /etc/g6-inventory/runtime.env
sudo -u inventory-deploy env INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:SHA_DE_40_CARACTERES docker compose --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml --project-name g6-inventory config --quiet
```

**Referencia histórica del procedimiento del PR #122; no es el registro vigente ni debe ejecutarse literalmente.** En ese snapshot la salida esperada era `["api-gateway","catalog-svc","inventory-svc","taxonomy-svc"]`. El manifiesto versionado vigente contiene nueve servicios seleccionables manualmente (`enabled=true`); los nueve continúan con auto-release deshabilitado. La auditoría del 19-oct observó cuatro contenedores de aplicación: Gateway, Catalog, Pricing y Taxonomy. Manifiesto elegible, autorización de auto-release y contenedores observados son estados diferentes. Sustituye el marcador por un SHA real de imagen únicamente para validar la sintaxis de Compose; no uses `up` ni `pull`.

Con aprobación operativa independiente, actualiza el Compose instalado antes de desplegar una imagen genérica de Inventario; conserva el archivo anterior para restaurarlo. La candidata se valida sin resolver ni imprimir el contenido privado y sin iniciar contenedores:

```bash
sudo cp --preserve=mode,ownership,timestamps /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml /var/backups/g6-productos-ofertas/docker-compose.inventory.yml.pr7
sudo install --owner root --group root --mode 0644 docker-compose.inventory.yml /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml.new
sudo env INVENTORY_IMAGE=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:SHA_DE_40_CARACTERES docker compose --file /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml.new config --quiet
sudo mv --no-target-directory /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml.new /opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml
```

Si la validación falla, elimina solo el candidato `.new`; si el cambio ya se sustituyó y la operación lo requiere, instala el respaldo como `.restore` y usa `mv --no-target-directory` para volver a la versión anterior. Verifica checksum y permisos. No ejecutes el despliegue como parte de esta actualización.

### 3. Cambiar el wrapper de forma reversible

Instala primero una copia temporal y confirma que apunta al ejecutor recién instalado. Después reemplaza el destino SSH antiguo mediante renombre atómico:

```bash
sudo install --owner root --group root --mode 0755 ops/oracle/deploy-inventory-svc.sh /usr/local/sbin/deploy-inventory-svc.new
sudo grep -F '/usr/local/lib/g6-productos-ofertas/deploy-g6-service' /usr/local/sbin/deploy-inventory-svc.new
sudo mv --no-target-directory /usr/local/sbin/deploy-inventory-svc.new /usr/local/sbin/deploy-inventory-svc
```

Prueba el rechazo de un comando no autorizado localmente como el usuario SSH. El resultado esperado es un error `comando remoto no autorizado`; esta prueba no abre el despliegue ni toca Docker:

```bash
sudo -u inventory-deploy env SSH_ORIGINAL_COMMAND=connectivity-probe /usr/local/sbin/deploy-inventory-svc
```

Luego verifica la ruta SSH desde Actions con la prueba `connectivity-probe` del workflow. El comando histórico `inventory-deploy <SHA>` se acepta por el wrapper y conserva el Compose de `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml`, el proyecto `g6-inventory`, el contenedor `g6-inventory-svc`, el puerto `127.0.0.1:3005`, `DATABASE_URL` de `/etc/g6-inventory/runtime.env` y el estado de `/var/lib/g6-inventory`.

Si la prueba local o de Actions falla, restaura el archivo previo (no reinicia ni despliega contenedores):

```bash
sudo install --owner root --group root --mode 0755 /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7 /usr/local/sbin/deploy-inventory-svc.restore
sudo mv --no-target-directory /usr/local/sbin/deploy-inventory-svc.restore /usr/local/sbin/deploy-inventory-svc
sudo sha256sum /usr/local/sbin/deploy-inventory-svc /var/backups/g6-productos-ofertas/deploy-inventory-svc.pr7
```

Los checksums deben coincidir con los anotados antes del cambio. Conserva la copia hasta que el wrapper nuevo y una ejecución normal de Inventario hayan sido auditados por sus responsables. La ejecución normal de despliegue se hace separadamente y requiere aprobación operativa y credenciales configuradas.

## Transición optativa a la red HTTP privada

Los Compose base actuales siguen usando la red privada propia de cada proyecto, publican los healthchecks solo en `127.0.0.1` y no requieren que exista `g6-http`. Los siguientes archivos son overlays optativos que el ejecutor v4 añade solo cuando el operador los instala en su ruta exacta:

- Servicios genéricos: `docker-compose.service.http.yml` en `/opt/g6-productos-ofertas/shared/docker-compose.service.http.yml`; el alias de `g6-http` se deriva del nombre cerrado de imagen/servicio del registro.
- Inventory: `docker-compose.inventory.http.yml` en `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.http.yml`; alias `inventory-svc`, conserva proyecto `g6-inventory`, contenedor y healthcheck existentes, y `127.0.0.1:3005`.

Cada overlay conserva además la red `default` de su proyecto. El overlay genérico es compartido: una vez instalado, se aplica a todos los servicios genéricos habilitados que se desplieguen mediante este ejecutor; no habilita una selección de red individual por servicio. El overlay separado de Inventory solo aplica al flujo de Inventory cuando se instala expresamente. Si un overlay está instalado pero la red falta o no satisface el contrato esperado, el ejecutor falla antes de autenticar GHCR, descargar imágenes o ejecutar Compose. Sin overlay instalado, los despliegues existentes no inspeccionan ni dependen de `g6-http`. Los archivos no conectan RabbitMQ ni Caddy. El preflight exige `bridge`, alcance `local`, `internal=false`, `attachable=false`, `ingress=false`, `config-only=false`, IPAM `default` con al menos una configuración y cero opciones personalizadas. Rechaza miembros que no correspondan a servicios habilitados en el registro, que no tengan los labels Compose de proyecto/servicio registrados, aliases mal formados o duplicados, un alias canónico ausente para cada miembro y un miembro que ocupe el alias del servicio objetivo. Tolera únicamente que varios miembros genéricos habilitados compartan el alias implícito `service`, que proviene de la clave Compose común del template; `service` es ambiguo y está prohibido usarlo en URLs de upstreams. Los upstreams deben usar siempre aliases canónicos únicos como `catalog-svc`, `taxonomy-svc` e `inventory-svc`; cualquier duplicado de esos aliases se rechaza. La selección concreta de subnet/IPAM queda para la autorización B2, ya que no hay un CIDR aprobado en #8. La red no se crea desde el ejecutor.

La red bridge no-internal mantiene salida NAT hacia dependencias autorizadas como Supabase y JWKS. Se deben revisar las políticas de salida existentes antes de despliegues reales; la conexión a la red no acredita permisos, credenciales ni readiness de esas dependencias. `g6-http` es una red plana: Docker Compose no filtra tráfico entre sus miembros. Cada proyecto conserva su red privada propia y solo se agrega a la red común tras autorización; si se exige prohibir también tráfico lateral entre miembros, harán falta redes segmentadas o reglas de host adicionales, fuera del alcance de este cambio.

La topología genérica actual permite desplegar servicios progresivamente, pero no permite elegir la membresía de `g6-http` por servicio una vez instalado el overlay compartido. Si B2 requiere autorización de red granular por microservicio, hay que decidir un mecanismo cerrado por servicio (por ejemplo, una propiedad versionada del registro o overlays nombrados por servicio) y sus reglas de compatibilidad. Este PR no cambia el registro v2 ni crea esa arquitectura; hasta esa decisión, el overlay genérico requiere autorización operativa que cubra todos los servicios genéricos habilitados que usen el ejecutor.

### Instalación futura, solo después de autorización operativa B2

Este procedimiento es una guía; no se ejecutó al preparar este cambio. Primero confirma por canal operativo el alcance, ventana y aprobación de cada archivo/red. No ejecutes `up`, `pull`, el CD ni un workflow como parte de instalar la infraestructura.

1. **Preflight y respaldo.** Registra `date -Is`, SHA de la versión revisada, `docker compose version`, `docker ps --format '{{.Names}} {{.Image}} {{.Status}}'`, `docker network ls`, `docker network inspect g6-edge` y el estado de salud de RabbitMQ con la comprobación operativa actual. Revisa sin imprimir secretos los archivos y permisos del ejecutor, registro, Compose, wrapper, `active-image` y `previous-image`. Respalda a `/var/backups/g6-productos-ofertas/<ticket>/` los archivos que vayas a sustituir, conservando dueño, modo, timestamps y SHA-256. Confirma que no cambias `.env`, volúmenes, topología, reglas, SSH, Caddy ni RabbitMQ.
2. **CD (nota histórica de procedimiento).** El texto original de este paso describía una allowlist de cuatro servicios y cinco deshabilitados, ya obsoleta. El manifiesto vigente lista nueve servicios; sus estados operativos y los contenedores realmente observados se distinguen en [ESTADO_SERVICIOS.md](ESTADO_SERVICIOS.md) y [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md). No uses el snapshot antiguo para validar ni operar el registro actual. No ejecutes despliegues sin autorización operativa individual.
3. **Red común.** Si `g6-http` ya existe, inspecciona driver, opciones, etiquetas y miembros antes de reutilizarla; detente ante diferencias. Si no existe, créala únicamente con autorización explícita, como bridge Docker no-internal. Comprueba que no se conectaron RabbitMQ ni Caddy y que permanece la salida requerida. No crees la red desde este PR/CD.
4. **Artefactos.** Instala el ejecutor y `service-registry.sh` según las rutas root-owned documentadas arriba; conserva `services.psv` v2 sin habilitar servicios. Instala el Compose genérico base sin editarlo y valida `--version`, checksum, propietario/modo y `docker compose config --quiet` con imagen SHA de prueba. La ausencia de overlay mantiene compatibilidad. Instala el overlay de Inventory solo si se autorizó conectar Inventory; en otro caso conserva el despliegue legado. Instala los overlays genéricos solo para servicios autorizados y después de que la red exista. Valida cada configuración con `docker compose config --quiet`; no inicies contenedores.
5. **Contrato para #110/Gateway.** Axel debe entregar el Compose específico del Gateway. Este debe ser el único proyecto nuevo conectado tanto a `g6-edge` como a `g6-http`, con alias estable `g6-api-gateway` en `g6-edge`; el proxy Caddy debe apuntar a ese nombre y solo Caddy/Gateway deben compartir `g6-edge`. El Gateway se conecta a los microservicios por sus aliases del registro en `g6-http`, con estas URLs de origen para el contrato actual: `GATEWAY_CATALOG_SVC_URL=http://catalog-svc:3001`, `GATEWAY_TAXONOMY_SVC_URL=http://taxonomy-svc:3006`, `GATEWAY_PRICING_SVC_URL=http://pricing-svc:3002`, `GATEWAY_PRICE_AUDIT_SVC_URL=http://price-audit-svc:3003`, `GATEWAY_PROMOTIONS_SVC_URL=http://promotions-svc:3004`, `GATEWAY_COMBOS_SVC_URL=http://combos-svc:3007`, `GATEWAY_INVENTORY_SVC_URL=http://inventory-svc:3005` y `GATEWAY_BULK_SVC_URL=http://bulk-svc:3008`. No configures una URL hasta que el servicio tenga despliegue autorizado y readiness funcional; la readiness de Gateway consulta `/health/ready` de cada upstream configurado. Caddy no se conecta a `g6-http`; RabbitMQ permanece en su red actual. Cambios al Caddyfile son una operación separada coordinada con #20/#110 y requieren autorización específica.
6. **Integración progresiva.** Antes de autorizar el despliegue de cada microservicio, prepara el runtime privado requerido, readiness real, healthcheck `/health`, permisos mínimos a Supabase/JWKS y política de salida. Confirma que el alias no está ocupado (`docker network inspect g6-http`), valida el Compose, revisa la selección de CD, y despliega solo el servicio autorizado. No actives componentes por lotes.
7. **Verificación.** Comprueba resolución Docker del alias desde el Gateway autorizado, conectividad TCP/HTTP a la dependencia permitida, healthcheck Docker y `/health` en loopback. Desde un cliente externo comprueba HTTPS, certificado, rutas del Gateway y que los puertos 3000–3008, 5672 y 15672 no responden públicamente. Revisa la tabla de miembros de `g6-edge`/`g6-http` para que solo Gateway esté en ambas; RabbitMQ no debe aparecer en `g6-http`. Valida el estado de RabbitMQ contra la captura de preflight y que SSH administrativo sigue disponible.
8. **Rollback.** El rollback automático del ejecutor revierte la imagen del mismo servicio cuando falla su healthcheck; conserva la topología Compose usada para esa ejecución. Si el problema es el overlay/topología, restaura la definición anterior por separado: respalda el overlay instalado; mueve únicamente ese archivo fuera de su ruta activa; valida el Compose base con la imagen que actualmente registra `active-image`; y recrea únicamente el servicio en su proyecto con `docker compose --project-name <proyecto> --file <compose-base> [--env-file <runtime-env>] up -d --no-deps --force-recreate <servicio>`. Para genéricos, usa el Compose base del servicio y el env privado de ese servicio; para Inventory, usa `g6-inventory` y su Compose legado. Verifica `docker inspect` de redes para confirmar que el contenedor dejó `g6-http`, `docker compose ps`/health y el endpoint de loopback (`/health`, puerto 3001–3008 según registro o Inventory en 3005). Si la recreación no desconecta la red externa, detente y evalúa una desconexión dirigida del contenedor del servicio afectado antes de repetir la verificación. No uses `down -v`, `--remove-orphans`, `docker network prune`, eliminación de `g6-http` ni comandos globales. Este procedimiento cambia topología de un solo proyecto; no altera RabbitMQ. Restaura atómicamente desde respaldo el archivo del ejecutor/Compose/overlay que corresponda y compara SHA/permisos. Mantén `g6-http` mientras tenga consumidores; no la elimines junto a otros proyectos. La reversión del Gateway/Caddy es coordinada aparte con #20/#110. Confirma health de servicios no involucrados, RabbitMQ y SSH al final.

Para ejecutar el rollback de topología genérico de `catalog-svc`, respalda y aparta solo el overlay compartido, recupera la imagen activa y recrea la clave Compose `service` desde la definición base:

```bash
sudo cp -a /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml /var/backups/g6-productos-ofertas/<ticket>/docker-compose.service.http.yml
sudo mv --no-target-directory /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml.disabled
IMAGE="$(sudo docker inspect --format '{{.Config.Image}}' g6-catalog-svc)"
sudo env G6_SERVICE_IMAGE="$IMAGE" G6_SERVICE_CONTAINER=g6-catalog-svc G6_SERVICE_PORT=3001 G6_SERVICE_PORT_ENV=CATALOG_SVC_PORT G6_SERVICE_IMAGE_NAME=catalog-svc G6_SERVICE_ENV_FILE=/etc/g6-catalog-svc/runtime.env docker compose --project-name g6-catalog-svc --file /opt/g6-productos-ofertas/shared/docker-compose.service.yml config --quiet
sudo env G6_SERVICE_IMAGE="$IMAGE" G6_SERVICE_CONTAINER=g6-catalog-svc G6_SERVICE_PORT=3001 G6_SERVICE_PORT_ENV=CATALOG_SVC_PORT G6_SERVICE_IMAGE_NAME=catalog-svc G6_SERVICE_ENV_FILE=/etc/g6-catalog-svc/runtime.env docker compose --project-name g6-catalog-svc --file /opt/g6-productos-ofertas/shared/docker-compose.service.yml up -d --no-deps --force-recreate service
sudo docker inspect --format '{{json .NetworkSettings.Networks}}' g6-catalog-svc
sudo docker inspect --format '{{.State.Health.Status}}' g6-catalog-svc
curl --fail --silent http://127.0.0.1:3001/health
```

Confirma que el JSON de redes ya no incluya `g6-http`, que el health sea `healthy` y que `/health` responda. Si falla la validación, reinstala el respaldo del overlay con `install` y renombre atómico, y detente para revisar el servicio antes de volver a desplegar. En Inventory se aplica el mismo procedimiento al overlay dedicado, Compose legado, proyecto `g6-inventory`, servicio `inventory-svc` e imagen `INVENTORY_IMAGE`; no se cambia el wrapper, `/var/lib/g6-inventory` ni el puerto `127.0.0.1:3005`. El rollback de imagen restaura la etiqueta/digest anterior en el mismo Compose; el rollback de topología restaura la definición de redes y recrea solo el servicio afectado. Son operaciones distintas y cada una debe verificarse por separado.

### Contrato pendiente para Axel en #110

Para usar el soporte de #8, el Compose del Gateway debe declarar `g6-edge` y `g6-http` como redes externas y conectar el servicio Gateway a ambas; su alias estable en `g6-edge` será `g6-api-gateway`. Debe definir health/readiness y no publicar puertos 3000–3008 en interfaces públicas. Los servicios conectados a `g6-http` conservan sus puertos enlazados a loopback para el CD/operación local. El Caddyfile y su proxy al alias solo cambian en el alcance coordinado de #20/#110. Este contrato describe la unión de redes; no decide rutas, autenticación, scopes ni permisos de API. La configuración de salud/runtime debe ajustarse al código fusionado de #116 y al Compose que Axel prepara; los artefactos de #8 no editan esos archivos.

## Cobertura de nueve servicios y gates de liberación

**Histórico:** la secuencia original de INFRA-002 describía cambiar una allowlist inicial de cuatro servicios a nueve. Ese cambio ya está integrado en `services.psv` del HEAD actual. La auditoría de VM reporta contenedores desplegados, no una allowlist vigente de cuatro; no reutilizar esa frase como estado operativo.

Los nueve servicios comparten el Compose base para sus puertos loopback, healthcheck, CA PostgreSQL de solo lectura y configuración privada. Gateway usa un Compose dedicado que añade su alias exclusivo en `g6-edge`; el overlay HTTP añade `g6-http`. Inventory conserva su wrapper, Compose, puerto 3005, entorno y estado heredados.

Directorio y estado son independientes por servicio. Si falta un archivo runtime o una credencial necesaria, el ejecutor falla cerrado y el servicio queda pendiente. Un `GET /health` solo acredita liveness. No publicar una versión sin verificar readiness funcional y autorización individual; el dispatch automático permanece desactivado.

## Secretos y operación del CD

El workflow conserva los nombres de secretos del PR #7. Deben provisionarse manualmente en GitHub Actions, nunca en archivos versionados:

| Secret                   | Propósito                                 |
| ------------------------ | ----------------------------------------- |
| `ORACLE_HOST`            | Host SSH verificado de la VM              |
| `ORACLE_USER`            | Usuario restringido de despliegue         |
| `ORACLE_SSH_PRIVATE_KEY` | Clave privada dedicada a Actions          |
| `ORACLE_SSH_KNOWN_HOSTS` | Clave del host verificada fuera de banda  |
| `ORACLE_GHCR_USERNAME`   | Usuario asociado al token de lectura GHCR |
| `ORACLE_GHCR_TOKEN`      | PAT dedicado con `read:packages`          |

### Tailscale, OIDC y política mínima

La configuración de confianza debe prepararla un Owner/Admin/Network Admin de Tailscale en Admin Console → Trust credentials → Credential → OpenID Connect:

| Campo | Valor/restricción |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:Taller-SW-Web/G6-Productos-Ofertas-backend:ref:refs/heads/master` |
| Claims adicionales | `repository=Taller-SW-Web/G6-Productos-Ofertas-backend`, `event_name=workflow_*`, `workflow_ref=Taller-SW-Web/G6-Productos-Ofertas-backend/.github/workflows/cd-services-oracle.yml@refs/heads/master` |
| Tags permitidos | Solo `tag:g6-deploy-actions` |
| Scope | `auth_keys` con permiso de escritura; no conceder `devices:core` ni otros scopes |

Guardar el Client ID y Audience no secretos como variables Actions `TS_OIDC_CLIENT_ID` y `TS_OIDC_AUDIENCE`. No crear ni guardar un OAuth client secret ni auth key para este flujo. Integrar con la política existente de la tailnet (sin reemplazar reglas ajenas) estos propietarios y grant mínimo:

```json
"tagOwners": {
  "tag:g6-deploy-actions": ["autogroup:admin"],
  "tag:g6-oracle": ["autogroup:admin"]
},
"grants": [
  {
    "src": ["tag:g6-deploy-actions"],
    "dst": ["tag:g6-oracle"],
    "ip": ["tcp:22"]
  }
]
```

El administrador debe etiquetar Oracle con `tag:g6-oracle` y confirmar por separado que las reglas existentes no amplían el acceso efectivo. Verificar que la política permite al job contactar el endpoint OIDC público durante el intercambio. Oracle debe mantener SSH restringido al comando forzado y sin forwarding/PTY; Actions usa el Tailscale IP/MagicDNS privado, sin abrir SSH público para sus runners.

El comodín `workflow_*` cubre los dos eventos preservados, `workflow_run` y `workflow_dispatch`; el `workflow_ref` limita la identidad a este archivo. El issuer, subject, audience y claims deben confirmarse en el admin de Tailscale con un token de prueba del propio workflow; los claims estándar de GitHub pueden variar si se cambia el disparador o se añade un Environment. Tailscale documenta federación OIDC y `auth_keys` de escritura para esta acción en [Workload identity federation](https://tailscale.com/docs/features/workload-identity-federation) y [tailscale/github-action](https://github.com/tailscale/github-action).

### Secretos existentes de Oracle

GitHub muestra creados los seis nombres `ORACLE_*` exigidos por el workflow. GitHub no permite recuperar sus valores, así que no se han leído ni impreso. Antes de probar el probe SSH, el administrador debe verificar en secreto que `ORACLE_HOST` es la IP Tailscale o MagicDNS de Oracle y que `ORACLE_SSH_KNOWN_HOSTS` contiene la clave host verificada fuera de banda para ese mismo nombre. `ORACLE_USER` debe resolver al usuario restringido esperado; `ORACLE_SSH_PRIVATE_KEY` debe corresponder a su clave autorizada. Confirmar además que `ORACLE_GHCR_TOKEN` es PAT classic con solo `read:packages` y acceso al paquete. `ORACLE_GHCR_USERNAME` debe ser el dueño de ese PAT. No volver a imprimir ni copiar los valores.

El `GITHUB_TOKEN` del job publica con `packages: write`; el PAT enviado por stdin al host necesita solo `read:packages`. El ejecutor existente conserva las verificaciones y rollback del servicio seleccionado.

El SSH debe aceptar únicamente el wrapper de despliegue mediante `authorized_keys`, sin PTY, forwarding ni shell interactiva. Conserva la ruta forzada existente:

```text
command="/usr/local/sbin/deploy-inventory-svc",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <CLAVE_PUBLICA>
```

Verifica la huella de `known_hosts` fuera de banda; no uses `ssh-keyscan` como fuente de confianza. Limita la red SSH a runners con origen conocido y permite salida HTTPS hacia GHCR. El `GITHUB_TOKEN` publica con `packages: write`; el PAT enviado por stdin al host necesita solo `read:packages` y acceso al paquete. El puerto 3005 se mantiene en loopback; no requiere apertura del firewall ni de reglas de Oracle. No inspecciones ni modifiques el Compose o `.env` de RabbitMQ.

Para cada servicio futuro, crea su directorio `/etc/g6-<servicio>` como `root:g6-<servicio>` modo `0750` y el archivo `runtime.env` como `root:g6-<servicio>` modo `0640`, concediendo solo lectura al usuario de despliegue. Conserva credenciales y estado distintos por servicio. Inventario mantiene intactos `/etc/g6-inventory/runtime.env` y `/var/lib/g6-inventory`.

## Pruebas locales

Las pruebas `ops/oracle/tests/validate-cd-source.test.sh`, `select-cd-services.test.sh`, `deploy-g6-service.test.sh` y `publish-isolation.test.sh` usan respuestas GitHub simuladas o registros temporales. Comprueban CI push exitosa en `master`, rechazo de pull requests/forks/CI fallida, SHA obsoleto como no-op, dispatch manual con CI exitosa, los nueve servicios por dispatch manual y autorización automática individual con evidencia obligatoria. Las simulaciones del ejecutor cubren compatibilidad del comando SSH previo, rollback, despliegues simultáneos, rollback concurrente, wrapper manual de Inventory frente al comando genérico e aislamiento de servicios. Si Docker daemon e `inventory-svc:ci` están disponibles, `deploy-g6-service.test.sh` crea una red bridge temporal aislada y dos proyectos Compose con la clave común `service`, inspecciona aliases reales y ejecuta el preflight real hasta el gate de imagen antes de login/pull/up; el `trap` retira solo los proyectos y la red temporal creados por la prueba. Si no están disponibles, declara ese paso `NO EJECUTADO`. `deployment-api.test.sh` comprueba ciclo de vida y estados; `publish-isolation.test.sh` comprueba fail-fast, concurrencia y errores de publicación. El CI además construye y ejecuta `Dockerfile.service` para los servicios habilitados, valida Compose y sus puertos/env/healthchecks. Nada de esto despliega en Oracle.
