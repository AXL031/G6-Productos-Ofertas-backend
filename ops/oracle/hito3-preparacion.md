# Preparación Oracle G6 para Hito 3

> **Corte operativo posterior:** el estado real se inspeccionó por SSH el 2026-10-19. Consulta [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md) y la [auditoría fechada](auditorias/2026-10-19_22-32-52_UTC/RESUMEN.md). Las tablas y anotaciones de fechas anteriores son antecedentes, no una lectura del runtime actual.

Referencia: auditoría `G6-ORACLE-20261017T011831Z`. Rama de trabajo: `castilla`.

## Estado

La infraestructura base está parcialmente preparada para nueve componentes. La elegibilidad del manifiesto y los cambios de Compose siguen pendientes de revisión e integración. Ningún microservicio fue desplegado. La preparación de Oracle no equivale a readiness funcional ni a autorización de liberación.

| Fase | Estado | Evidencia y pendientes |
|---|---|---|
| A. Autorización, preflight y respaldo | COMPLETADO | Autorización de Marco registrada en #8. Respaldo privado recuperable descrito abajo. |
| B. Ejecutor y preparación de nueve servicios | PARCIAL | Ejecutor v4 y registro integrado v2 revisados instalados; Oracle conserva su allowlist integrada de cuatro servicios. Cambios para nueve preparados en `castilla`, pendientes de PR/CI/revisión/integración. |
| C. Redes y directorios | PARCIAL | `g6-http` creada; `g6-edge` conservada. Directorios/estados independientes preparados. No hay miembros de aplicaciones desplegados. RabbitMQ sin cambios y sin servicios G6 que requieran AMQP identificados en el código revisado. |
| D. Supabase y runtime | PARCIAL | CA pública Supabase instalada en host y verificada; no hay certificados montados en servicios ni credenciales runtime configuradas. Catálogo y Taxonomía quedan `PENDIENTE_CREDENCIAL`. Gateway queda pendiente de upstreams/runtime. |
| E. Caddy y HTTPS | PARCIAL | Caddy y certificado existentes conservados. Caddyfile sin cambios; Gateway no está desplegado ni funcionalmente listo, así que sigue pendiente cambiar el 503 provisional. |
| F. Tailscale y SSH | PARCIAL | Clave SSH de despliegue existente restringida y validada. `tailscaled` responde `NeedsLogin`; requiere que Marco confirme/inicie sesión en la tailnet autorizada y que Actions pueda acceder por esa ruta privada. No se abrió SSH público adicional. |
| G. Publicación manual | PENDIENTE | No hay autorización de liberación individual para ningún servicio. No se ejecutó CD ni migraciones. |
| H. Entrega a agente B | PENDIENTE | No activar CD automático hasta completar los gates indicados al final. |

## Actualización de continuación (2026-10-17 02:25 UTC / 2026-10-16 21:25 Lima)

- Las dos ejecuciones CI del PR #122 sobre `7672b4711e7680196cf59be5d4209a77175b4a0d` terminaron SUCCESS. El log confirma que `ops/oracle/tests/deploy-g6-service.test.sh` se ejecutó, y que sus comprobaciones de rollback/aislamiento reportaron PASS. La suite no fue omitida.
- `master` avanzó a `950fd20499d67c6f265dcde4a40971f4c4fb6180` (PR #118). Se sincronizó `castilla` mediante merge no destructivo en `b2fb417cebbffeabd055310d8ec41e4ffbc5aae7`; no se hizo rebase. El PR #122 permanece draft, sin review decision/aprobación.
- Oracle sigue en Docker 29.9.0 / Compose 5.6.0, ejecutor `ejecutor=4 registro=2`, con allowlist integrada de cuatro servicios. Caddy está running; RabbitMQ está healthy; no hay contenedores de aplicación. `g6-http` permanece vacía, `g6-edge` tiene solo `g6-caddy`, y `g6-po_g6_backend` tiene solo `g6-po-rabbitmq-1`. Esto confirma separación de redes, pero no prueba conectividad DNS/HTTP entre aplicaciones que aún no están desplegadas.
- Los ocho directorios nuevos `/etc/g6-<servicio>` y `/var/lib/g6-productos-ofertas/<servicio>` existen con modos 0750 y 0700 respectivamente. API Gateway, Catalog y Taxonomy no tienen `runtime.env`; los otros cinco archivos preparados son 0640 y vacíos. Inventory mantiene `/etc/g6-inventory/runtime.env` (root:g6-inventory-deploy, 0640) y `/var/lib/g6-inventory` (inventory-deploy:g6-inventory-deploy, 0700), sin leer el contenido runtime.
- En el host, `docker compose config --quiet` pasó para el Compose genérico instalado aplicado a los ocho servicios no-Inventory, y para el Compose/overlay instalado de Inventory. El Compose genérico instalado no incluye todavía el montaje CA de solo lectura, y el registro sigue apuntando Gateway al Compose genérico heredado. El Compose dedicado Gateway (`g6-edge` + overlay `g6-http`) del PR no se instaló antes de aprobación/integración; su compatibilidad se validó en CI Linux del commit anterior. No ejecutar Gateway hasta instalarlo desde el commit integrado y configurar upstreams listos.
- SHA-256 observados en Oracle a `2026-10-17 02:25:09 UTC`: ejecutor v4 `f06b0fb48ed4d08a26114beeae339aea809ba3b762880907168b7281dd6acd40`; `service-registry.sh` `ab95405450a9b4f9f5527381d444c7de6fa58ddc64afb12ae7fbe9aa3dab4a30`; allowlist integrada `services.psv` `259e53249ffd0764231f4bf5a96a85c061b1464895ec095df61b4cae9b0bba57`; Compose genérico instalado `bb2fdefa5f25744aa7f7d7c151d42a80559fb689bdfd1ba0a35da13299551180`; overlay genérico `6f404818256f6fb4639faf64466f4400845190c2f07cd950cd7928075dbeb5fe`; Compose Inventory `1fec0615e1c229c5bcbe41a02eceda2feaedf2d14e46454d12774ac4e4250879`; overlay Inventory `6658c2157b9bdf246ff1607f7bc1338f973e5f28486b3cc0e4ee89b1b0b9b50c`. Estos hashes confirman que el registro de nueve y el Compose candidate siguen pendientes en Oracle.
- PostgreSQL sigue sin prueba de conectividad/autenticación/rol/permisos: no se proporcionaron credenciales runtime para Catalog/Taxonomy. La CA permanece en host como root:root 0444 y aún no está montada en containers.
- Tailscale continúa `NeedsLogin` y no tiene IP. Se requiere que Marco identifique/confirme la tailnet aprobada y autentique/apruebe el nodo Oracle desde esa tailnet; la autenticación no se ejecutó. Luego el administrador del repositorio debe provisionar la integración de Actions con identidad tagged/ephemeral autorizada y cambiar el destino SSH al MagicDNS/IP privada. Mantener cerrado el acceso de runners por SSH público.

### Configuración PostgreSQL requerida, sin secretos

- `catalog-svc` usa `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT=/run/g6-certs/supabase-server-root.crt`, `G6_DATABASE_SCHEMA=catalog`, `G6_EXPECTED_ROLE` (`catalog_dev_login` o `catalog_app`) y `G6_CONNECTION_MODE` (`session` o `direct`). `G6_CONNECT_HOST` es opcional para el endpoint de transporte; TLS valida el nombre de `PGHOST`.
- `taxonomy-svc` recibe estos datos por `DATABASE_URL` (`sslmode=verify-full`, `sslrootcert=/run/g6-certs/supabase-server-root.crt`, `currentSchema=taxonomy`) y runtime `G6_EXPECTED_ROLE` (`taxonomy_dev_login` o `taxonomy_app`) más `G6_CONNECTION_MODE` (`session` o `direct`).
- En ambos casos el código valida certificado y hostname y luego `verifyIdentity()` comprueba usuario/base/schema, que el rol no tenga superuser/BYPASSRLS/CREATEROLE/CREATEDB y que no sea miembro del owner del schema. Esta validación runtime no se pudo ejecutar porque faltan credenciales y endpoint aprobados. No pedir ni pegar contraseñas en el chat; el operador debe cargarlas directamente en los archivos privados protegidos y coordinar solo el resultado sanitizado.

### Acceso privado para GitHub Actions

El repositorio tiene los seis secretos `ORACLE_HOST`, `ORACLE_USER`, `ORACLE_SSH_PRIVATE_KEY`, `ORACLE_SSH_KNOWN_HOSTS`, `ORACLE_GHCR_USERNAME` y `ORACLE_GHCR_TOKEN`; la lista no incluye integración Tailscale. No se inspeccionaron sus valores. El workflow actual aún no incorpora un cliente Tailscale; por tanto, no usar su dispatch para desplegar hasta completar el acceso privado y cambiar `ORACLE_HOST` a MagicDNS/IP privada. No permitir runners por SSH público.

Acción humana requerida: Marco debe identificar/confirmar la tailnet autorizada; el administrador/owner de esa tailnet debe autenticar y aprobar el nodo Oracle (por ejemplo, iniciando `sudo tailscale up`, abriendo el enlace de autenticación en la cuenta organizacional correcta y aprobando el dispositivo en Admin Console). Después, Marco/el administrador de GitHub debe configurar la federación/OAuth de Actions, un tag y una política ACL/SSH de mínimo acceso compatibles con esa tailnet, provisionar la autenticación de Actions sin poner claves en Git, y probar `connectivity-probe` por el nombre privado. No se eligió tailnet, tag ni política en esta misión.

Referencias operativas actuales: [Tailscale: configurar servidores](https://tailscale.com/kb/1245/set-up-servers), [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action) y [conectar workflows de GitHub con infraestructura privada](https://tailscale.com/kb/1586/secure-github-runners).

## Estado al 2026-10-17 02:31 UTC / 2026-10-16 21:31 Lima

El PR #122 sigue draft en head `4dfd34a9219b411499154a603af55008aef436fa`, base `950fd20499d67c6f265dcde4a40971f4c4fb6180`. La CI más reciente del PR (run `38994972094`) terminó SUCCESS; el job incluye y pasó `Simulate generic Oracle deployment, isolation and rollback`, y completó las validaciones Compose y Marketplace. La CI anterior del commit solicitado `7672b47` también terminó SUCCESS y el log confirmó que la prueba de despliegue corrió. No se observan approvals/reviews para #122. El issue #111 sigue OPEN, sin comentarios de autorización de liberación.

`docker compose config --quiet` pasó en Oracle para el Compose genérico instalado y su overlay para los ocho servicios no-Inventory, y para el Compose/overlay Inventory. El Compose dedicado de Gateway del PR no se ha instalado. Las redes solo permiten confirmar topología/membresía, no conectividad de aplicaciones sin contenedores miembros. No se ha confirmado ninguna identidad PostgreSQL, permiso efectivo, readiness de aplicación o HTTPS de Gateway.

### Estado operativo de los nueve componentes

`PREPARADO` significa infraestructura host/directorios/Compose genérico comprobados; no acredita readiness funcional. Ninguno está listo para liberar o desplegado.

| Servicio | Estado | Pendiente específico |
|---|---|---|
| api-gateway | INFRAESTRUCTURA_PREPARADA | PR integrado, Compose dedicado/CA, upstreams reales, health/readiness y Caddy. |
| catalog-svc | INFRAESTRUCTURA_PREPARADA | PR integrado, credential PostgreSQL mínimo privilegio, TLS verify-full y prueba de rol/permisos. |
| pricing-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| price-audit-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| promotions-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| inventory-svc | INFRAESTRUCTURA_PREPARADA | Configuración heredada preservada; readiness funcional no acreditada. |
| taxonomy-svc | INFRAESTRUCTURA_PREPARADA | PR integrado, credential PostgreSQL mínimo privilegio, TLS verify-full y prueba de rol/permisos. |
| combos-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |
| bulk-svc | INFRAESTRUCTURA_PREPARADA | Readiness funcional; `/health` solo acredita liveness. |

## Registro de operaciones en Oracle

Tiempos de las operaciones de Oracle entre `2026-10-17 01:58 UTC` y `2026-10-17 02:13 UTC` (Lima: `2026-10-16 20:58`–`21:13`, UTC−5). Las horas exactas de respaldo y autorización se conservaron en sus metadatos y en el issue #8.

- `2026-10-17 02:00:10 UTC` / `2026-10-16 21:00:10 Lima`: respaldo en `/var/backups/g6-productos-ofertas/hito3-oracle-20261017T020010Z`, dueño root, modo 0700; archivos y metadatos con acceso restringido. Incluye ejecutor anterior, registros, Compose de servicios, Compose/Caddyfile existentes y archivos de despliegue de Inventory. `SHA256SUMS` pasó `sha256sum -c`; se compararon contenidos con los originales. `authorized_keys` tuvo respaldo separado antes de restringir la clave de Actions.
- Se instaló `/usr/local/lib/g6-productos-ofertas/deploy-g6-service` v4 y el soporte/registro revisado desde el commit `9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de`. Hashes de fuente contrastados con Git; versión reportada `ejecutor=4 registro=2`. Los archivos instalados son root-owned con modos restringidos.
- Se verificó el registro del host con los cuatro servicios autorizados ya integrados. **No se reemplazó `services.psv` por el candidato de nueve** antes de su aprobación e integración.
- Se creó Docker bridge `g6-http` (`internal=false`, `attachable=false`, sin opciones personalizadas), sin contenedores conectados. `g6-edge` permanece intacta y con Caddy como único miembro. No se conectó RabbitMQ a ninguna red nueva.
- Se prepararon grupos y directorios privados por servicio, con estado separado. Inventory conserva `/etc/g6-inventory/runtime.env`, `/var/lib/g6-inventory`, su wrapper y Compose legado; no se reinició ni modificó RabbitMQ.
- CA Supabase `Supabase Root 2021 CA` copiada a `/etc/g6-postgres/supabase-server-root.crt`, root:root, modo 0444; hash SHA-256 contrastado con el archivo fuente y certificado parseable con OpenSSL. El montaje de solo lectura queda incluido en el Compose candidato, no instalado hasta revisión.
- Se añadieron opciones de restricción a la clave pública preexistente `github-actions-g6-cd` sin sustituir su fingerprint: sin port-forwarding, agent-forwarding, X11 ni PTY. La autenticación sigue comprobada por la ruta pública existente; no se amplió el firewall. El acceso privado Tailscale no está listo.

Versiones observadas durante el preflight: Ubuntu 24.04, Docker 29.9.0, Compose 5.6.0, Caddy 2.11.6 y RabbitMQ 4.2.9-management. No se cambiaron versiones ni se reiniciaron esos servicios.

## Configuración y readiness por servicio

Los nueve tienen rutas de estado/runtime y parámetros de Compose definidos en el manifiesto candidato. El `runtime.env` se creó vacío solo para servicios cuyo código actual no exige secretos/configuración externa. No se inventaron endpoints, credenciales ni variables de aplicación.

| Servicio | Puerto | Situación runtime y readiness |
|---|---:|---|
| api-gateway | 3000 | Runtime/upstreams no configurados; readiness depende de upstreams disponibles. PENDIENTE. |
| catalog-svc | 3001 | Requiere conexión PostgreSQL segura y credencial runtime de mínimo privilegio. PENDIENTE_CREDENCIAL. |
| pricing-svc | 3002 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| price-audit-svc | 3003 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| promotions-svc | 3004 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| inventory-svc | 3005 | Configuración heredada preservada. No se cambió la implementación ni se atribuye readiness funcional. |
| taxonomy-svc | 3006 | Requiere conexión PostgreSQL segura y credencial runtime de mínimo privilegio. PENDIENTE_CREDENCIAL. |
| combos-svc | 3007 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |
| bulk-svc | 3008 | Archivo runtime vacío; solo `/health` identificado. Readiness funcional no acreditada. |

La revisión del código de los nueve servicios no identificó consumidores/productores RabbitMQ actuales; por ello ningún servicio fue conectado a la red del broker. Esto deberá revisarse al integrar nuevas implementaciones que declaren dependencia AMQP.

## Validaciones realizadas

- Respaldo: `sha256sum -c` PASS y comparación exacta de archivos respaldados.
- Oracle: `ejecutor=4 registro=2`, hash de artefactos contrastado, `g6-http` verificada, permisos de directorios y key restrictions verificados. RabbitMQ/Caddy se inspeccionaron sin reinicio.
- Local: `git diff --check` PASS; `select-cd-services.test.sh` PASS para los nueve; `publish-isolation.test.sh` PASS.
- `deploy-g6-service.test.sh`: **NO PASS**. En Windows/Git Bash, `docker compose config` resolvió mal una ruta temporal del archivo de Inventory y la prueba terminó en `Compose de Inventory con g6-http inválido`. Requiere repetición en Linux/CI; no se declara validación completa.
- No se ejecutaron migraciones, consultas de escritura, CD, pulls de imágenes ni despliegues. No se validó conectividad autenticada Supabase, health/readiness real de aplicaciones ni TLS extremo a extremo.

## Rollback

- Restaurar archivos privilegiados desde `/var/backups/g6-productos-ofertas/hito3-oracle-20261017T020010Z` solo después de verificar hashes/permisos y detener la operación correspondiente. El respaldo no debe exponerse al usuario de despliegue.
- La restricción SSH se revierte restaurando el `authorized_keys` respaldado tras una revisión de acceso; comparar fingerprint original antes de instalar.
- No eliminar `g6-http` si aparece algún consumidor. Si aún está vacía, se puede retirar únicamente tras verificar que no hay endpoints/conexiones; no ejecutar prune.
- Mantener `g6-edge`, contenedores y volúmenes de Caddy/RabbitMQ/Inventory. No utilizar `down -v`, prune ni cambios globales.
- Cada servicio conserva su propio `active-image`, `previous-image` y estado. No se cambiaron imágenes ni esos marcadores.

## Prerrequisitos antes de agente B

1. Revisar e integrar el PR de elegibilidad de nueve servicios desde `castilla`; confirmar CI exitosa, incluyendo la repetición de la prueba integral en Linux. El manifiesto de Oracle debe actualizarse manualmente desde el commit exacto integrado, con respaldo y verificación de hash.
2. Marco debe iniciar sesión en la tailnet autorizada o coordinar la autenticación aprobada. Configurar el host de Actions por Tailscale y confirmar que runners autorizados alcanzan SSH privado; no abrir puerto 22 al público para GitHub-hosted runners.
3. El operador debe proporcionar credenciales runtime dedicadas de mínimo privilegio y endpoint de conexión Supabase para Catalog/Taxonomy, confirmar TLS `verify-full` con la CA instalada, y validar conectividad, autenticación, rol y permisos sin imprimir secretos. Ningún valor se guardó o consultó en este lote.
4. Proveer y validar config de Gateway según interfaces integradas y servicios realmente listos; mantener Caddy en su estado actual hasta que Gateway tenga health, readiness y HTTPS verificables.
5. Obtener autorización de liberación por cada servicio con SHA/CI aprobado, runtime completo, imagen disponible, readiness funcional y rollback revisado. La autorización general de infraestructura no sirve como autorización de despliegue.
6. El agente B puede activar CD automático solo después de acordar y revisar explícitamente ese cambio. Esta misión no lo habilitó.

## Continuación PostgreSQL y revisión de exposición (2026-10-17 03:04 UTC / 2026-10-16 22:04 Lima)

Esta sección supersede los estados PostgreSQL anteriores que indicaban credenciales pendientes para Catalog/Taxonomy. No modifica la auditoría base `G6-ORACLE-20261017T011831Z`.

### Decisión de Marco sobre credenciales

Marco decidió conservar las ocho credenciales `_dev_login` existentes para Hito 3. No se cambiaron contraseñas, roles ni permisos PostgreSQL, no se crearon usuarios y no se ejecutaron migraciones ni consultas de escritura. El riesgo de exposición no se considera resuelto: el resultado de una comprobación incluyó líneas de credenciales en la salida de herramientas de esta conversación.

Alcance observado de la exposición:

- **Ubicación confirmada:** salida stdout de la herramienta del agente registrada en el transcript de esta conversación/tarea. La salida fue recibida desde una sesión SSH iniciada por PowerShell; no se encontró en el historial PSReadLine local. No se creó deliberadamente un archivo con esa salida ni se redirigió a archivos o a la salida de Actions. El transcript de la conversación puede ser visible para quienes tengan acceso a esta tarea; no se pudo inspeccionar ni purgar la retención interna de la plataforma.
- **Repositorio/GitHub público:** se revisaron 880 blobs alcanzables en las refs Git locales después de actualizar refs remotas; no hubo coincidencias exactas con los ocho valores actuales. Ningún `.env.local`/`runtime.env` aparece entre los archivos del PR #122. Los comentarios de PR están vacíos, no hay revisiones, no hay artefactos del run CI y los logs revisados no contienen patrones de URI PostgreSQL, asignación `PGPASSWORD`/`DATABASE_URL` ni nombres de los roles runtime. En comentarios de los issues #8, #20, #110 y #111 no se detectaron formatos comunes de credenciales. No se encontró una copia pública en esos recursos.
- **Límites:** estas comprobaciones cubren las refs descargadas, el PR/CI identificado y los comentarios indicados; no prueban acceso o retención de plataformas fuera de esta inspección ni permiten afirmar que nadie con acceso al transcript haya visto la salida. No borrar evidencia de auditoría. Marco decidió no rotar; el riesgo residual permanece abierto.

### Runtimes PostgreSQL instalados

Operación en Oracle completada a partir de los ocho archivos `.env.local` ubicados en `C:\Users\marec\Desktop\G6-PostgresRuntime-Privado` (el nombre real de los archivos no era `.env.example`). No se copiaron al repositorio ni se imprimieron sus valores durante la instalación. Se validó el mapeo de endpoint de Session Pooler (`aws-0-sa-east-1.pooler.supabase.com:5432`), usuario con formato de rol más project ref, rol esperado, esquema, base y `verify-full`. `PGSSLROOTCERT` apunta a `/run/g6-certs/supabase-server-root.crt`.

Los ocho archivos están en sus rutas registradas `/etc/g6-<servicio>/runtime.env`, modo 0640, root y grupo de servicio. Inventory conserva el `DATABASE_URL` existente byte por byte y recibió las claves PG adicionales. Antes de modificarlo se creó `/var/backups/g6-productos-ofertas/postgres-runtime-20261017T025648Z/inventory.runtime.env.pre`; el checksum coincide con el respaldo. La CA host continúa como `/etc/g6-postgres/supabase-server-root.crt`, modo 0444.

La conexión PostgreSQL desde el host Oracle se observó entre `2026-10-17T02:56:48Z` y `2026-10-17T02:58:26Z` (`2026-10-16T21:56:48-05:00` a `21:58:26-05:00`). Para los ocho roles hubo TCP PASS y consultas de solo lectura que confirmaron autenticación, identidad esperada, `USAGE` del esquema y ausencia de `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` y membresía al owner. Se observaron permisos SELECT/INSERT/UPDATE/DELETE sobre tablas existentes: catalog 14, taxonomy 13, pricing 8, price_audit 5, promotions 14, inventory 16, combos 6 y bulk 8; `CREATE` de esquema fue false para todos. Las conexiones `psql` se abrieron forzando `sslmode=verify-full` con la CA host, por lo que TLS/hostname se consideran PASS histórico. Una salida intermedia clasificó incorrectamente el booleano textual de `pg_stat_ssl` y mostró TLS FAIL; el resultado se corrigió al constatar que la propia sesión `psql` conectó con `verify-full`. No se repitieron pruebas con secretos después de conocer la exposición.

| Servicio | Configuración | TCP | TLS verify-full | Autenticación | Rol | Permisos | Readiness funcional |
|---|---|---|---|---|---|---|---|
| catalog-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; integración PostgreSQL implementada, servicio no desplegado |
| taxonomy-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; integración PostgreSQL implementada, servicio no desplegado |
| pricing-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; conexión PostgreSQL no implementada en el código revisado |
| price-audit-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; conexión PostgreSQL no implementada en el código revisado |
| promotions-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; conexión PostgreSQL no implementada en el código revisado |
| inventory-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; conexión PostgreSQL no implementada en el código revisado |
| combos-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; conexión PostgreSQL no implementada en el código revisado |
| bulk-svc | PASS | PASS | PASS histórico | PASS histórico | PASS histórico | PASS histórico | NO_VERIFICADO; conexión PostgreSQL no implementada en el código revisado |

Los estados PASS son evidencia histórica de host, previa a cualquier futura modificación de credenciales y no prueban conexión desde contenedor. Ningún microservicio se declara funcional o listo para liberar.

### PR #122 y estado operativo actual

- A `2026-10-17T03:04Z`, PR #122 sigue draft, abierto, sin aprobación ni revisión registrada, head `0ec8bcd3fea2f5d227ddd75762d4ecb2c4b53b61`, base `950fd20499d67c6f265dcde4a40971f4c4fb6180`. El run CI `38995257656` terminó SUCCESS; su job pasó y ejecutó `Simulate generic Oracle deployment, isolation and rollback` (step 17), no fue omitido. No se hizo merge.
- La inspección técnica detectó que Inventory usa su Compose legado `/opt/g6-productos-ofertas/inventory/docker-compose.inventory.yml` y su overlay HTTP opcional; no usa el Compose genérico que ahora monta la CA. El overlay Inventory versionado solo conecta `g6-http`, no monta `/etc/g6-postgres/supabase-server-root.crt` como `/run/g6-certs/supabase-server-root.crt:ro`. Se intentó registrar `REQUEST_CHANGES`, pero la integración GitHub devolvió 403 `Resource not accessible by integration`; no se publicó review ni comentario. La brecha queda pendiente de corrección y CI antes de aprobar/instalar Compose.
- Corrección PR #122: el overlay HTTP de Inventory ahora añade el montaje CA indicado como solo lectura, y las comprobaciones de CI/deploy test inspeccionan la configuración Compose efectiva, incluyendo ruta fuente/destino y `read_only=true`, además de preservar alias `g6-http`, healthcheck y puerto heredado. Cambio preparado en esta rama para revisión; queda pendiente la CI Linux del nuevo commit y la aprobación/instalación posterior. Oracle no fue modificada por esta corrección.
- Tailscale ahora reporta `BackendState=Running` y dos direcciones en Oracle (observado `2026-10-17T03:04:57Z`). No se eligió una tailnet durante esta operación. Sigue sin probarse acceso SSH privado desde un runner: el workflow actual no conecta Actions a Tailscale y no se modificó el CD.
- En Oracle siguen activos solo `g6-caddy` y `g6-po-rabbitmq-1`; no hay contenedores G6 de aplicación. No se modificaron Caddy, RabbitMQ ni el CD, ni se instaló el Compose candidato aún no aprobado/integrado.

Acciones pendientes: (1) Marco revisa la brecha de montaje CA de Inventory y aprueba/integra PR #122 cuando quede corregido; (2) instalar en Oracle desde el SHA exacto integrado los Compose/registro/ejecutor y comprobar hashes; (3) preparar integración de Actions por Tailscale y validar SSH privado; (4) configurar upstreams reales del Gateway y luego coordinar el cambio de Caddy; (5) autorizar cada despliegue manual por separado tras CI de master, runtime, readiness funcional y rollback; (6) el agente B gestiona cualquier habilitación de CD automático. La decisión de no rotar se respeta y el incidente conserva riesgo residual pendiente de la evaluación de acceso al transcript.
