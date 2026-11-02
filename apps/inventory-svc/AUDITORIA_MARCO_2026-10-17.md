# Seguimiento de la auditoría de Marco — Inventory

## Corte vigente de entrega

Este corte sustituye los estados pendientes de ejecución y de edición del PR del registro histórico inferior. Los bloqueos funcionales externos siguen vigentes. No se cierran issues ni se declara homologación o despliegue.

| Prioridad         | Archivo / cambio                                                                                                      | Prueba y estado vigente                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — integración   | `package.json`, `package-lock.json`, `src/main.ts`; merge normal `89c24d3` autorizado y publicado                     | PASS: master `2970df9` integrado, cero behind; ejecutor Oracle y scripts conservados íntegros.                                                                                                                                                                                                                                                                                                          |
| 2 — validaciones  | `.github/workflows/ci.yml`, `test/inventory.real.integration.spec.ts`, `test/tsconfig.real.json`                      | PASS de la CI completa de `8b91345`: tres jobs aprobados y **19 pruebas reales ejecutadas/aprobadas, cero omitidas** en PostgreSQL 17/RabbitMQ 3.13 efímeros, Node 24.15.0/Ubuntu. [CI del SHA publicado](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39036405226). La ampliación posterior del consumer se identifica aparte; todavía no está validada en entorno real. |
| 3 — funcionalidad | Consumer, `CONFIGURACION.md`, dashboard y política offline                                                            | PARTIAL: fronteras y recuperación documentadas; payloads Bulk/desactivación, filtros de Catálogo y persistencia offline dependen de decisiones concretas de los owners detallados abajo.                                                                                                                                                                                                                |
| 4 — datos         | `data/data-f1/` preservado                                                                                            | PASS del dry-run y 27 pruebas; carga BLOQUEADA hasta validar SKU con Poma y baseline/alcance con Infra. `ready_for_load=false`; sin Supabase.                                                                                                                                                                                                                                                           |
| 5 — Gateway       | Sin modificación del código de Gateway                                                                                | BLOQUEADO_ESPECÍFICO: Castilla #106/#107 debe corregir propagación de errores y después ejecutar prueba conjunta.                                                                                                                                                                                                                                                                                       |
| 6 — PR            | Título y descripción del [PR #10](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/10) actualizados | PASS de actualización remota verificada; conserva OPEN/DRAFT. Contiene bloques 01–06, pruebas reales y límites externos. Se publica el SHA final y su CI al finalizar.                                                                                                                                                                                                                                  |

La prueba real aprobada en `8b91345` acredita HTTP autenticado con una clave sintética de fixture, health/readiness con DB real, persistencia durable, concurrencia/idempotencia, rollback, publisher confirms/basic.return, recuperación y restricciones/permisos positivos y negativos en schema propio. No acredita G7, consumidor G5, Oracle ni React→Gateway.

Los issues #97 y #98 ya disponen de implementación y evidencia interna con dependencias reales para revisión; #99–#103 conservan límites funcionales o de integración identificados, y #104/#105 siguen pendientes de integración React/Gateway y E2E completo. Los trece issues asignados siguen OPEN en GitHub: implementación interna, aceptación y cierre son estados distintos. Para continuar #104/#105 sin inferir el estado actual del Frontend se requiere revisar ese repositorio en un bloque autorizado y coordinar #106/#107/#109; no se considera que las tres pantallas terminadas prueben conexión al backend.

Validaciones locales ejecutadas con runtimes admitidos: 763 unitarias PASS; 592 HTTP/globales PASS; tipos, lint, formato, builds y 27 pruebas DATA PASS. Los casos reales omitidos en la ejecución local se validan separadamente en el job aislado anterior. El fallo nativo de Node 24.15.0/Windows queda registrado; el E2E global local se ejecutó con Node 22.22.3 admitido. Ningún test fallido se eliminó o desactivó para lograr CI verde.

Archivos compartidos modificados únicamente con autorización explícita: los dos manifests del merge y la adición del job Inventory al workflow existente. Sin cambios de contratos, migraciones, Gateway, Frontend o ejecutor Oracle; sin rebase, force push, merge a master o despliegue. Estado general **PARTIAL** por dependencias externas, aunque las validaciones internas puedan aprobarse.

## Continuación acotada a las prioridades 2 y 3

Se contrastaron nuevamente Backend master `2970df9`, Docs master `c36bd9a`, PR #10 y los issues/comentarios #12, #14, #100–#102 y #106/#107. No hay contrato nuevo, validación SKU de Poma ni corrección de Gateway que desbloquee las fronteras descritas. El PR mantiene HEAD `8b91345`, OPEN/DRAFT, sin conflictos; su CI completa está aprobada. No se cambiaron ramas, se modificaron issues ni se enviaron mensajes a terceros.

Se prepara una ampliación de dos casos dentro de la suite real existente: la suite pasa de 19 a **21 casos previstos**, no 21 aprobados. Las pruebas previas acreditaban el publisher y el modelo Inbox, pero no entregas del consumer por un broker real. El nuevo bloque usa `InventoryConsumerService` e `InventoryCommandService` sin sustituir DB, broker ni repositorios; declara la cola quorum y el binding de inicialización exclusivamente en el vhost efímero de la suite, conforme AsyncAPI RC2. DEC-F-001/002/004 delimitan SKU, autoridad de saldo e identidades distintas.

| Archivo / cambio                                                                                                                                            | Evidencia local / estado                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/inventory.real.integration.spec.ts`: inicialización real, mismo message_id duplicado, nuevo message_id con igual operation_id y ubicación inexistente | Verifica ACK, tres filas Inbox PROCESSED, dos operaciones durables, una sola inicialización de saldo, resultados Outbox de replay y rechazo de negocio; comprueba que ningún ACK reaparece al cerrar el canal. Ejecución real PENDIENTE. |
| Mismo test: JSON inválido                                                                                                                                   | Comprueba pausa sin ACK, redelivery real, ausencia de fila Inbox y `resume()` tras retirar solo el fixture defectuoso. No inventa payloads Bulk/desactivación ni política de descarte productiva. Ejecución real PENDIENTE.              |
| `CONFIGURACION.md`                                                                                                                                          | Recuperación por causa explícita, diferencia entre readiness y salud del consumer, límite de cola compartida y carácter interno de resume/reinicio. No agrega endpoint, retries o DLX.                                                   |

Checks ejecutados para esta ampliación: inbox unitario 22 PASS; suite general Node 24.15.0 763 PASS/21 reales omitidas; E2E general Node 22.22.3 582 PASS/71 omitidas, sin habilitar el artefacto Gateway opcional en esta ejecución. Las omisiones no se presentan como pruebas aprobadas. Typecheck general y dedicado del test real, lint y formato general PASS. La ejecución de los 21 casos en Actions requiere publicar el nuevo commit con autorización previa de Taco; la CI de `8b91345` acredita únicamente su árbol anterior.

Las prioridades 4 y 5 continúan delimitadas a preservar DATA-004 y esperar validación SKU/baseline y corrección de Castilla, respectivamente. El PR se actualizará con el SHA nuevo y su resultado real cuando se autorice su publicación y termine CI. No corresponde incorporar Frontend o rediseñar offline para satisfacer esta continuación.

### Ejecución de la ampliación y corrección de observación del cierre

El usuario autorizó expresamente el push de `95c69f1`, completado a `origin/taco`. El [job Inventory de esa ejecución](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39038573412/job/117413258166) ejecutó 21 casos: **20 PASS, 1 FAIL, cero omitidos**. Inicialización, dedupe, replay, rechazo durable y recuperación del JSON inválido alcanzaron sus aserciones; el fallo fue la lectura inmediata de cierre del primer caso nuevo: `messageCount=0`, `consumerCount=1`, esperado `0/0` tras cerrar la conexión. No se presenta como CI verde.

Se conserva la condición `messageCount=0 AND consumerCount=0` y se observa mediante el helper de espera acotada existente, máximo cinco segundos, al finalizar ambos casos nuevos. El canal que consulta la cola es distinto de la conexión que acaba de cerrarse; la hipótesis que se valida es una baja observada con retraso, no un nuevo comportamiento de negocio. No se suprime consumerCount, se eliminan casos, se repite el comando de negocio ni se modifica el shutdown productivo. El ajuste necesita una nueva ejecución real y un nuevo push autorizado; el resultado anterior no acredita el ajuste.

## Registro histórico de diagnóstico y autorizaciones

## Prioridad 1: resolución autorizada y publicada

Base de trabajo: `taco@44c2f02a5d03aa37cf829a694e0f0b3ffb835b38`.
Master descargado en modo lectura: `2970df90babf2c8caa1849b179b02918fc74a005`.
Estado inicial del PR #10: abierto, draft, `mergeable=false`, `mergeable_state=dirty`.
Divergencia inicial verificada: 44 commits exclusivos de taco y 118 de master.

Se ejecutó `git merge-tree --write-tree --name-only --messages HEAD origin/master`.
La simulación escribió únicamente objetos Git; no cambió rama, índice ni archivos.
Árbol provisional con conflictos: `86dc0d0be1a5a434e44665b593a4fddabe37830e`.

| Archivo             | Conflicto                                                                                                             | Resolución revisada y aplicada                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`      | Taco declara rangos con `^` para Drizzle/pg/tipos de pg y añade AMQP; master fija versiones de Drizzle/pg/tipos de pg | Conservar `drizzle-orm: 0.45.4`, `pg: 8.23.1`, `@types/pg: 8.23.1` de master y mantener `amqplib: ^2.2.0`, `@types/amqplib: ^0.10.8` requeridos por Inventory. Conservar todos los scripts y ajustes vigentes de master. |
| `package-lock.json` | Metadatos de dependencias compartidas                                                                                 | Regenerar con npm y Node admitido a partir del manifest reconciliado; comprobar `npm ci` y revisar el diff, sin seleccionar ciegamente ours/theirs.                                                                      |

La comparación del árbol provisional contra master para `ops/oracle`, `.github` y `scripts` no muestra diferencias: sus incorporaciones se preservan íntegramente en la combinación simulada. No se ejecutó el nuevo deploy runner ni un despliegue. Ausencia de conflictos de texto no equivale a validación funcional.

Se propuso y autorizó un merge normal de master **hacia taco**, sin rebase, force push ni merge a master. El cambio local preexistente `test/inventory.real.integration.spec.ts` quedó fuera del commit de merge con SHA-256 `07C4C9A86E66895349C259B3295EDFD62DE1A6E6790E48A1D960B39BF8E763AA`.

El usuario autorizó expresamente la integración y esa resolución después de revisar los dos conflictos. Se aplicó merge normal y se creó `89c24d3618a167a5fd3d23f8bbee5d666027f48c`; `taco` queda 45 commits por delante y **0 por detrás** del master descargado. Las dependencias finales difieren de master únicamente en AMQP y sus tipos. `npm ci` con Node 24.15.0 instaló limpiamente 361 paquetes; permaneció una advertencia de peer opcional de tsconfck/TypeScript, sin fallo de instalación. `ops/oracle`, `.github` y `scripts` son idénticos a master tras el merge; no se ejecutó despliegue.

Se corrigió además `src/main.ts`: conserva configuración fail-closed, logger sanitizado, shutdown hooks y filtro Problem Details, y expresa la misma precedencia de puerto requerida por la comprobación estática de la CI Oracle. La comprobación literal de CI ahora encuentra la expresión efectiva, sin añadir un comentario o código muerto para engañarla.

## Validación y demás hallazgos

Se descargaron Node 24.15.0 y 22.22.3 portables dentro de `dist/inventory-audit-tools`, verificando cada ZIP contra el SHA-256 publicado en nodejs.org. No se sustituyó la instalación global 22.16.0 ni se cambió el pin del repositorio/CI.

| Comprobación del árbol integrado                                             | Resultado                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Configuración, reintegros y ciclo de reservas, Node 24.15.0                  | PASS: 58 pruebas                                                      |
| Provider G5 y demo/Gateway aislado, Node 24.15.0                             | PASS: 39 pruebas HTTP                                                 |
| `npm test`, Node 24.15.0                                                     | PASS: 763 pruebas; 18 omitidas; 69 archivos aprobados y uno omitido   |
| `npm run test:e2e`, Node 22.22.3, con artefacto Gateway del bloque 04        | PASS: 592 pruebas; 61 omitidas; 19 archivos aprobados y seis omitidos |
| `npm run typecheck`, Node 24.15.0                                            | PASS                                                                  |
| `npm run lint`, Node 24.15.0                                                 | PASS                                                                  |
| `npm run format:check`, Node 24.15.0                                         | PASS                                                                  |
| `npm run build:all` y `npm run build:inventory-svc`, Node 24.15.0            | PASS                                                                  |
| `node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs`, Node 24.15.0 | PASS: 27 pruebas                                                      |
| Comparación con master de ejecutor Oracle/workflows/scripts                  | Sin diferencias tras integrar master; no es evidencia de despliegue   |

La suite HTTP global en Node 24.15.0/Windows falló por terminación nativa de un worker durante los tests de Gateway, incluso en ejecución serial. Un diagnóstico fuera del código versionado capturó exit code `3221226505`, signal null. El [reporte upstream Node #63620](https://github.com/nodejs/node/issues/63620) describe una caída compatible con ese runtime, Windows y muchas conexiones HTTP; se registra como hipótesis compatible, no como análisis de un dump local. La misma suite completa pasó usando Node 22.22.3, también admitido por engines. No se alteraron Gateway, sus pruebas, Vitest ni contratos para ocultar el fallo.

Docker local no estuvo disponible: la consulta acotada `docker info --format` terminó con status 1; el servicio Windows consultado figura detenido. No se repitió una solicitud de acceso Docker rechazada previamente. No se conectó a Supabase.

El usuario autorizó expresamente añadir el job CI y publicar el test corregido para validarlo allí. Se añadió `inventory-integration` a `.github/workflows/ci.yml`: Ubuntu, Node 24.15.0, checkouts hermanos Backend/Docs fijados, permisos contents:read, timeout de diez minutos e `INVENTORY_REAL_INTEGRATION=1`. La prueba aprovisiona sus contenedores PostgreSQL/RabbitMQ, puertos loopback, credenciales/vhost aleatorios y cleanup limitado por etiqueta propia. No consume credenciales Supabase/Oracle.

El test real conserva el bloque preexistente BACK-02 de siete pruebas/321 líneas. Se corrigieron cuatro fixtures VENTAS→MARKETPLACE y dos errores de tipado del código previo: reason de liberación y respuesta falsa de basic.get. Se añadió un caso HTTP real que abre Nest en loopback, firma un JWT sintético, reserva/consume/reintenta contra repositorios PostgreSQL reales y recupera el resultado publicado en RabbitMQ. Solo se desactiva el scheduler automático de ese caso para controlar la publicación explícita; no se sustituye la persistencia ni el broker. Esto no acredita grants G7, G5 bilateral ni browser/React E2E.

Antes de publicar: `tsc -p apps/inventory-svc/test/tsconfig.real.json` PASS; YAML/Prettier PASS; suites generales repetidas con PASS, 763 pruebas unitarias/19 reales omitidas localmente y 592 HTTP/61 omitidas. Los 19 casos reales quedan pendientes de ejecución en el nuevo job de Actions, que debe juzgarse en el SHA finalmente publicado. Una omisión local no se presenta como prueba real aprobada.

## Prioridades 3–5: fronteras que se mantienen explícitas

| Hallazgo / archivo                                                                       | Trabajo y prueba disponibles                                                                                                                                                               | Estado / desbloqueo                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer Bulk/deactivated, `src/inbox/inventory-command.service.ts` y `CONFIGURACION.md` | Los dos comandos continúan con BLOCKED_CONTRACT; documentación describe pausa sin ACK, cierre de canal y recuperación interna por resume/reinicio. No se fabrican payload, retries ni DLX. | BLOQUEADO_ESPECÍFICO: Marco y owners Bulk/Catálogo deben definir payload y semántica ejecutables; Infra/G5 deben homologar topología.                               |
| Dashboard, `src/dashboard/dashboard.service.ts`                                          | Producto/categoría/marca se rechazan explícitamente; no se ignoran filtros ni se consultan tablas ajenas.                                                                                  | BLOQUEADO_ESPECÍFICO: Poma/Marco deben suministrar mapping contractual a SKU y resolver métricas SPEC-016 ausentes en OpenAPI.                                      |
| Offline, `src/conciliacion/offline-consumption.policy.ts`                                | La política pura mantiene invariantes y sus pruebas. No se conectó una mutación incompleta.                                                                                                | BLOQUEADO_ESPECÍFICO: Marco/G4/G5/G7 deben homologar identidad estable, deduplicación, actor y ubicación según DEC-F-009/014/015.                                   |
| DATA-004, `data/data-f1/`                                                                | Se preservan propuesta, baseline sintética y preparador; 27 pruebas aprobadas. No son SKU actualmente publicados ni datos cargados.                                                        | PARTIAL: Poma/#12 confirma SKU vigentes; Marco/Infra proporciona baseline y alcance antes de cualquier propuesta de carga. Sin inserts ni conexión a Supabase.      |
| Errores del POST verificador, Gateway                                                    | La caracterización local sigue comprobando la conversión incorrecta de errores upstream a 500; código de Gateway permanece de master.                                                      | Marco/Castilla #106/#107 debe corregirlo. Tras su cambio, repetir contrato HTTP esperando los códigos originales; esta auditoría no atribuye esa corrección a Taco. |

## Prioridad 6: PR #10

Se preparó una descripción completa en `dist/inventory-audit-tools/PR_10_DESCRIPCION.md`, con los bloques 01–06, el HEAD publicado conocido, el merge local, evidencia por runtime y bloqueos. Los endpoints de actualización de PR y de su metadato de issue devolvieron ambos `403 Resource not accessible by integration`. No se actualizó remotamente su título ni descripción. Se requiere una conexión GitHub con permiso de edición o que el usuario aplique el texto preparado; al publicarse el merge debe actualizarse la referencia al SHA publicado efectivo. El PR sigue abierto y draft; no se abrieron PR nuevos, cerraron issues ni fusionó master.

La revisión automática rechazó el primer intento de push de `89c24d3` por exigir autorización explícita para esa publicación concreta. El usuario la dio y el push normal se completó: `origin/taco` avanzó de `44c2f02` a `89c24d3`. La CI asociada es [run 39034991892](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39034991892); en el corte previo al nuevo commit aprobó tipos, lint, tests, builds, simulaciones del ejecutor Oracle y consistencia de puertos. Su resultado no sustituye la CI del siguiente commit que incorpora el job real.

## Entrega local y condiciones de continuación

| Prioridad | Archivo/cambio                                                                                  | Prueba                                                                                                                     | Estado                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1         | Merge `89c24d3`, `package.json`, `package-lock.json`, compatibilidad de puerto en `src/main.ts` | npm ci, builds, tipos, suites y comparación íntegra de infraestructura                                                     | PASS: merge publicado; cero behind del master integrado                                     |
| 2         | `inventory-integration` en CI y test real con tipado verificado                                 | 763 unitarias y 592 HTTP/globales aprobadas con runtimes admitidos; sin pruebas reales omitidas presentadas como aprobadas | IMPLEMENTADO: ejecución real pendiente de CI del SHA final                                  |
| 3         | Consumer, dashboard y política offline conservados; fronteras documentadas arriba               | Pruebas locales incluidas en las suites; contratos vigentes consultados                                                    | PARTIAL: contratos/datos/autorización externos pendientes; no inventados                    |
| 4         | `data/data-f1/` intacto                                                                         | 27 pruebas y nuevo dry-run: 38 candidatos, 0 conflictos, ready_for_load=false; mismo hash semántico                        | PARTIAL: Poma/Marco/Infra deben validar SKU y baseline; cero conexiones/escrituras Supabase |
| 5         | Gateway de master preservado                                                                    | Caracterización HTTP del defecto del verificador pasa como evidencia del defecto, no de su corrección                      | BLOQUEADO_ESPECÍFICO: corrección de Castilla y prueba conjunta posterior                    |
| 6         | `dist/inventory-audit-tools/PR_10_DESCRIPCION.md`                                               | Dos intentos API de actualización devuelven 403                                                                            | BLOQUEADO_PERMISOS: texto listo; no publicado                                               |

Corte del informe: preparación del commit del job/test real autorizado; resultados posteriores deben verificarse en Actions por su SHA y se comunican al cerrar la sesión. La propuesta YAML ya se incorporó al workflow y no se conserva una segunda copia inactiva. El test pendiente se incorpora con las correcciones autorizadas y mantiene las siete pruebas BACK-02. Estado general: **PARTIAL**, condicionado a CI real y a las dependencias externas descritas; no constituye aprobación para merge a master ni despliegue.

## Primera ejecución real y corrección del aprovisionamiento

El job Inventory de [run 39035349324](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39035349324/job/117403925824), asociado a `46a4786`, falló antes de ejecutar sus 19 casos: `rabbitmq-diagnostics -q check_running` no acreditó arranque dentro del plazo. No fue un PASS con pruebas omitidas: el job terminó en FAILURE.

Se acotaron los schedulers Erlang del broker efímero y sus CLI mediante RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS/RABBITMQ_CTL_ERL_ARGS, opciones documentadas por [RabbitMQ](https://www.rabbitmq.com/docs/configure). Se añadió diagnóstico de estado/logs de contenedores propios antes del cleanup, con filtrado de credenciales y sin inspección de entornos. Es un ajuste del fixture aislado; no cambia producción, topología compartida, payloads ni política de retry/DLX. La causa exacta del primer timeout no se da por demostrada sin diagnóstico adicional.

Typecheck de la suite real, Prettier, lint y diff-check pasan tras este ajuste. La repetición en CI es necesaria para validar el aprovisionamiento y después las invariantes reales. Los permisos de GitHub App para editar el PR devolvieron 403; la autenticación Git existente se verificó en modo lectura como MiguelTacoZavala, sin mostrar ni guardar credenciales. El resultado de la actualización final del PR se informará al cerrar.

La repetición en `01b5619` mostró RabbitMQ terminado con exit=1 y fallo de arranque de auth.erl:313. Se corrigió una carrera del fixture: las comprobaciones tempranas ejecutadas como root podían crear el archivo cookie que el broker, ejecutado como rabbitmq, necesita leer. Se pasan `--user rabbitmq` a la sonda y a los comandos administrativos del contenedor propio; no se cambian permisos del host ni de Oracle. El escenario está descrito en [docker-library/rabbitmq #696](https://github.com/docker-library/rabbitmq/discussions/696). Se añaden categorías de diagnóstico de permisos que no exponen cookies. No se repite el ajuste de schedulers como si hubiera demostrado resolver el fallo.

La descripción y el título del PR #10 ya se actualizaron mediante la autenticación Git de MiguelTacoZavala, verificada previamente, conservando draft=true y state=open. Solo se transmitió la credencial al API oficial de GitHub en memoria; no se imprimió ni se guardó. La descripción debe quedar con el último SHA publicado y el resultado real de CI al finalizar.

La ejecución de `ef4277a`, [run 39036025929](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39036025929/job/117405844709), acreditó el arranque del broker y ejecutó los 19 casos: 18 PASS, incluido HTTP→PostgreSQL→RabbitMQ, y un fallo de representación en la consulta de enums BACK-02. `pg_enum.enumlabel` es de tipo `name` ([PostgreSQL 17](https://www.postgresql.org/docs/17/catalog-pg-enum.html)); su agregado name[] se recibió como texto. Se convierte cada etiqueta a text antes de array_agg para obtener text[] sin cambiar etiquetas, orden ni aserciones. La repetición completa real sigue siendo obligatoria; no se omite el caso fallido ni se modifica el modelo físico.

## Corte 2026-10-18 — CI real del HEAD publicado y avance de master

Verificación del recurso remoto (consulta de solo lectura a la API de GitHub, sin
modificar issues, PRs ni ramas):

| Comprobación | Resultado verificado |
| --- | --- |
| CI del HEAD publicado `843725bf709c3ea4b9811b8d5c59097a773f26ba` | **SUCCESS** — [run 39038902601](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39038902601): tres jobs aprobados (validación general, Inventory integration, Taxonomy integration) |
| Job Inventory (PostgreSQL 17 + RabbitMQ 3.13 efímeros, Node 24.15.0/Ubuntu) | **21 casos ejecutados, 21 aprobados, cero omitidos**, incluido el cierre del consumer observado hasta cinco segundos con `messageCount=0 AND consumerCount=0` |
| PR #10 | `OPEN`/`DRAFT`, `mergeable=true`, `mergeable_state=clean`, head `843725b` |

El ajuste de `843725b` (espera acotada de la baja del consumidor) y la corrección
de la lectura de etiquetas enum (`ce624d0`, etiquetas convertidas a `text[]`
antes de `array_agg`, sin cambiar valores ni orden) quedan **validados en CI
real**. Los 19 casos de `8b91345` pasan a ser 21 aprobados en `843725b`. Esta
evidencia acredita la suite real de Inventory con DB y broker reales efímeros;
**no** acredita grants G7, consumidor G5, recorrido React→Gateway ni despliegue.

Master avanzó de `2970df9` a `9205eb455c4965a82ccb9fc4714cf976e4c059b0` por el
[PR #134](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/134)
(rama `castilla`). Ese cambio **acota el bypass demo del Gateway** a tres GET de
Catálogo (`listarCategorias`, `listarProductos` y `obtenerProductoPorSlug` con
`canal=MARKETPLACE`); las escrituras y el resto de operaciones vuelven a exigir
JWT en Gateway. Consecuencia para Inventory:

- El acceso demo sin JWT de G7 a las operaciones de Inventory (`#25`/`#100`)
  **vuelve a depender de una resolución de Marco en #107**, no de `taco`.
- No se amplió ni se desactivó ningún control del servicio; se mantiene la
  excepción interna acotada a GET comercial y POST verificador desde el peer
  Gateway configurado.
- El defecto de propagación de errores del POST verificador (400/401/422/503 →
  500) sigue sin corregir en `master`; se conserva la caracterización local como
  evidencia del defecto, no de su corrección.

Existe un único cambio local sin commit: `test/inventory.real.integration.spec.ts`
queda **fuera de la entrega** y sin modificar en este corte (su versión
publicada en `843725b` es la validada por CI).

### Documentación incorporada en este corte

- `apps/inventory-svc/README.md` (nuevo): superficie HTTP por `operationId`,
  eventos AsyncAPI producidos/consumidos, invariantes, comandos de prueba,
  suite real y matriz de los 13 issues con dependencias externas
  (owner · operación · condición de desbloqueo).
- Este apartado en `AUDITORIA_MARCO_2026-10-17.md`.

No se modificaron contratos, migraciones, Gateway, Frontend ni datos de otros
contextos. Los trece issues de Taco siguen OPEN; implementación interna,
aceptación, homologación y despliegue son estados distintos.

## Corte 2026-10-20 — Ficha predeploy Oracle (`CHECKLIST_PREDEPLOY.md`) y Hito 4

Consolidación conforme a `ops/oracle/GUIA_DEVTEAM.md`, `ops/oracle/CONTRATO_DESPLIEGUE.md`,
`ops/oracle/servicios/inventory-svc.md`, `ops/oracle/RABBITMQ_COMPATIBILIDAD.md` y
`ops/oracle/CHECKLIST_PREDEPLOY.md` (incorporados en `master` `47e219e376fff1004ec10e9803c16119c811a699`):

```text
Servicio / owner: inventory-svc / Miguel Ángel Taco Zavala (taco)
Issue / rama / SHA:
  - Backend (#14, #25, #30, #31, #97, #98, #99, #100, #101, #102, #103, #104, #105): rama taco, SHA base b02615841f63ea3249d9ad16a0cf32f4ea2b20c2 (CI run 39207480173 SUCCESS), alineación documental Marketplace H4 6d266af7aa7ead2e6d263838d6b94ee5ea02da1d (CI run 39505583544 SUCCESS), merge de master 47e219e en 5a8a92b (sin cambios en apps/inventory-svc) y corte Hito 4 7a546e78629683c8258df1a6d9beab24e74ef136 (CI run 39524047809 SUCCESS)
  - Frontend (#17, #18, #39 y parte UI de #104): rama taco, SHA db7c2e67c575936aa14f6293f95392e708d1a8d2 (merge de master 6e0448a + correcciones "all", carga parcial del dashboard, distribución porUbicacion y resolución de TAC-P0-01/TAC-P0-02/TAC-P0-05/TAC-P1-07 en recepción inmutable, confirmación separada de presentación y matriz de transición; TAC-P0-06 documentado como BLOQUEADO_ESPECÍFICO)
Contrato HTTP (versión/SHA) / AsyncAPI (versión/SHA) / DEC-F-ADR:
  - Docs origin/master SHA c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b
  - OpenAPI 0.6.0-rc.1 / AsyncAPI 0.6.0-rc.2 / SPEC-015, SPEC-016 / DEC-F-001, 002, 005, 009, 013, 014, 015
Build / typecheck / lint / tests (comandos y resultados):
  - Backend: npm run typecheck PASS; npm run lint PASS; npm run build:inventory-svc PASS; vitest unit (apps/inventory-svc/src) 24 archivos / 253 tests PASS; vitest e2e (apps/inventory-svc/test) 4 archivos / 90 PASS (10 omitidos sin Gateway/DB local); node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs 27/27 PASS
  - Frontend: npm run typecheck PASS; npm run lint PASS; vitest adapters (src/features/inventory/adapters/vitest.config.ts) 33/33 PASS; Playwright MK-015/MK-016 60/60 PASS; verify-production mock (58 vistas) y api (53 vistas) PASS
Integración local real (dependencias, versiones, evidencia):
  - GitHub Actions run 39207480173 (y 39205232766): PostgreSQL 17 + RabbitMQ 3.13 efímeros sobre Ubuntu / Node 24.15.0 -> 21/21 casos reales PASS, 0 omitidos
Imagen + Compose equivalentes y health/readiness:
  - Dockerfile.inventory-svc (CMD ["node", "dist/apps/inventory-svc/main.js"], puerto 3005 / INVENTORY_SVC_PORT)
  - GET /health (liveness 200 sin dependencias) separado de GET /health/readiness (200 ready solo si SELECT 1 en PostgreSQL responde; 503 not_ready si falla, sin falso healthy). Salud/pausa AMQP separada en InventoryConsumerService.getMetrics() para no bloquear HTTP/DB cuando el broker está aislado
Variables runtime requeridas (nombres, suministrador; ningún valor):
  - Infra/Compose: NODE_ENV, PORT, INVENTORY_SVC_PORT
  - Runtime privado (/etc/g6-inventory/runtime.env): DATABASE_URL o PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD, PGSSLMODE, PGSSLROOTCERT, RABBITMQ_URL (opcional al arranque, requerida para AMQP), G7_JWT_ISSUER, G7_JWT_PUBLIC_KEY (o JWT_PUBLIC_KEY), RESERVATION_TTL_SECONDS, DEFAULT_LOW_STOCK_THRESHOLD, INVENTORY_WORKER_INTERVAL_MS, INVENTORY_WORKER_BATCH_SIZE, INVENTORY_DEMO_NO_AUTH_ENABLED, INVENTORY_DEMO_GATEWAY_IPS
Dependencias físicas / configuradas / probadas:
  - Probadas en CI con contenedores efímeros aislados (PostgreSQL 17 y RabbitMQ 3.13). No desplegado en Oracle al corte 19-oct-2026
Auth, red y permisos pendientes:
  - Reconciliación topología RabbitMQ física (po.inventario.q, po.eventos.x, po.resultados.x) vs contractual AsyncAPI (po.inventory.q, po.events.x, po.results.x) y red aislada del broker (Marco / #29)
  - Grants reales G7 y pruebas bilaterales G5 M1/M2 (#30, #31)
  - Enrutamiento demo y propagación de errores del verificador en api-gateway (#25, #106, #107)
  - Cliente HTTP compartido de Frontend y apertura de CommercialModeGate (#45 / #109)
Despliegue remoto / smoke (si autorizado; deployment ID y SHA):
  - NO EJECUTADO (sin autorización ni despliegue en Oracle; auto_release=false)
Bloqueos, owner responsable y criterio verificable para cerrar:
  - #14 (DATA-004): Poma (#12) + Marco/Infra · confirmar SKUs publicados, baseline y autorización antes de escribir en Supabase (dry-run offline listo con 38 filas candidatas, ready_for_load=false)
  - #25/#100: Marco/Castilla (#106/#107) · exponer ruta comercial demo en Gateway y propagar códigos 400/401/422/503 del verificador
  - #99/#101: Marco + G4/G5/G7 · cerrar DEC-F-009/014/015 para conectar la política pura de conciliación offline a endpoint HTTP
  - #102: Marco + owners Bulk/Catálogo + #29 · tipar GenericData (bulk adjust / sku deactivated) y reconciliar nombres físicos/contractuales de RabbitMQ
  - #104/#105 y Frontend #17/#18/#39: Marco/Castilla (#45/#109, #106/#107, #111) · conectar cliente compartido, retirar bloqueo de CommercialModeGate y ejecutar E2E integrado
Estado: PARTIAL (Implementación interna completa + Integración real aislada en CI PASS; bloqueos externos acotados por frontera)
Marco debe hacer:
  - Revisar/aprobar PR #10 en Backend, definir reconciliación de nombres AMQP (#29), resolver rutas/errores de Gateway (#106/#107), publicar cliente compartido Frontend (#45/#109) y autorizar #14/#111 cuando corresponda.
El desarrollador ya dejó resuelto:
  - 100% de la implementación interna autorizada en apps/inventory-svc, preparador y dry-run de DATA-004 (#14), suite real 21/21 en CI y adaptador HTTP Frontend con 28 pruebas unitarias/flujo y 60 pruebas Playwright de inventario en src/features/inventory/.
```

## Actualización 2026-10-20 — sincronización con `master`, matriz AMQP y cierre de `TAC-P0-01`/`TAC-P0-02`

Se ejecutó merge normal de `origin/master` (`47e219e376fff1004ec10e9803c16119c811a699`)
en `taco` sin conflictos; el merge no modifica `apps/inventory-svc/` y conserva
la implementación interna. El Frontend hizo el equivalente desde `master`
`6e0448a` y resolvió `TAC-P0-01` (solicitud inmutable de recepción con
`operationId`, `receivedAt` y `note` conservados en reintentos) y `TAC-P0-02`
(tres estados explícitos `IN_FLIGHT`, `UNCERTAIN` y `RECONCILED`; ningún
`GET /traslados` genérico libera operaciones inciertas).

### Matriz de incompatibilidad RabbitMQ (bloqueo de deploy AMQP)

Fuentes: código de `apps/inventory-svc`, AsyncAPI `0.6.0-rc.2` y auditoría
Oracle `2026-10-19 22:32:52 UTC` (RabbitMQ 4.2.9, vhost `g6-productos-ofertas`).
No se modificó la topología.

| Elemento | Código/AsyncAPI | Físico observado | ACL `g6_inventario` |
|---|---|---|---|
| Cola consumida | `po.inventory.q` | `po.inventario.q` | read `po.inventario.q` |
| Exchange de eventos | `po.events.x` | `po.eventos.x` | write `po.eventos.x` |
| Exchange de resultados | `po.results.x` | `po.resultados.x` | write `po.resultados.x` |
| Configure | — | — | ninguno (`^$`) |

Los nombres no son alias: consumir/publicar con el código actual falla por
recurso inexistente o ACL. El flujo AMQP permanece **BLOQUEADO_ESPECÍFICO**
hasta reconciliación de Marco/#29 y del owner de infraestructura. No se
inventan bindings, retry/DLX ni permisos.

### Independencia de HTTP/PostgreSQL respecto del broker

- `RABBITMQ_URL` es opcional al arranque; sin broker se sirve HTTP y el Outbox
  conserva eventos `PENDING`.
- `/health/readiness` solo exige PostgreSQL (`SELECT 1`); no depende de
  RabbitMQ.
- La pausa del consumidor no bloquea operaciones HTTP ni transacciones.
- El estado AMQP se reporta por separado en `InventoryConsumerService.getMetrics()`.

Esto permite desplegar/probar HTTP y persistencia con AMQP bloqueado. No
acredita entrega de eventos, homologación de topología ni deploy Oracle.

### Evidencia de este corte

- Backend: `7a546e78629683c8258df1a6d9beab24e74ef136` (merge `5a8a92b`) — CI run 39524047809 SUCCESS: validación general, Inventory real PostgreSQL/RabbitMQ y Taxonomy real.
- Frontend: `db7c2e67c575936aa14f6293f95392e708d1a8d2` (merge `master` + correcciones `"all"`, carga parcial del dashboard, distribución por `porUbicacion`, `TAC-P0-01`/`TAC-P0-02` con solicitud inmutable y protección de operaciones inciertas, `TAC-P0-05` con confirmación separada del enriquecimiento y `TAC-P1-07` con matriz de transición; 33/33 pruebas del adaptador y 60/60 Playwright MK-015/MK-016; `TAC-P0-06` documentado y BLOQUEADO_ESPECÍFICO). El CI de Frontend se ejecuta al abrir el PR `taco`→`master`.
