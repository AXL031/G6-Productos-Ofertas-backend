# Auditoría del bloque 1 e implementación del bloque 2

> Nota posterior: el usuario autorizó después publicar `1fa3bae` y ampliar el PR
> #125 a todos los bloques. Su apartado D conserva la decisión de entrega local
> previa; ya no describe el estado remoto actual. El run `39031944960` ejecutó
> 12/12 PG y 5/5 RabbitMQ, y falló después en el smoke Marketplace. La auditoría
> correctiva y la evidencia nueva están en [AUDIT-BLOCK-3.md](AUDIT-BLOCK-3.md).

Fecha: 2026-10-17. Rama personal: `poma`. Owner: GabrielPGu.
Estado global: **PARTIAL**. Este informe acredita código y ejecuciones locales;
no acredita integración autenticada entre servicios, homologación ni despliegue.

## Fuentes y autorizaciones

- Issues backend #23, #45, #46, #47 y #48, consultados en GitHub.
- Repositorio normativo `Taller-SW-Web/G6-Productos-Ofertas-docs`:
  OpenAPI `0.6.0-rc.1` (blob `f64bfe9a097b2a0f74c2600988305443d92f640e`),
  AsyncAPI `0.6.0-rc.2`, catálogo de eventos y `rabbitmq-topologia.md`.
- SPEC-003/004, HU-003/004, FLOW-003/004, arquitectura, modelo físico y migración
  oficial `datos/catalog-svc/migrations/0001_create_catalog.sql`.
- Registro DEC-F, matriz de trazabilidad y matriz intermodular. Aplican DEC-F-001
  (SKU), -002 (autoridad Inventory), -006 (autoridad Pricing), -009
  (identidad/intención/dedupe), -011 (perfil físico KG/CM) y -012 (contratos y
  evidencia). Las reglas de reservas, cupones y conciliación pertenecen a sus
  respectivos contextos; no se implementan aquí.
- El usuario autorizó expresamente amqplib y sus tipos. `amqplib@2.2.0` queda
  fijado y ya distribuye sus tipos: no requiere paquete `@types` adicional.
- El usuario aprobó moneda inicial **PEN**, slug estable **nombre normalizado +
  UUID completo del producto**, y **SKU explícito por ahora** para variantes.
  El slug se conserva al editar. No se fabrica SKU cuando se omite.

## A. Auditoría de #45, #46 y #23

| Regla / hallazgo | Corrección / evidencia | Estado operativo |
| --- | --- | --- |
| BORRADOR, identidad SKU estable, preparación por SKU vendible | Dominio y nuevos casos de uso transaccionales; pruebas de dominio, inputs y persistencia desechable | IMPLEMENTAR_AHORA |
| Padre con variantes aceptaba hechos físicos/Inventory propios | El dominio rechaza ambos; tests positivos, negativos y de variantes no activas | IMPLEMENTAR_AHORA |
| Imagen, atributos y perfil positivo/completo al activar | Validación autoritativa Taxonomy, validadores físicos y dominio; no activar por requested/202 | IMPLEMENTAR_AHORA |
| Reactivación independiente, última variante activa | Estados y Outbox atómicos; casos PostgreSQL preparados, no ejecutados localmente | IMPLEMENTAR_AHORA |
| Cabecera JWT JSON `null`/primitiva/array podía provocar error interno | Rechazo explícito de token inválido; pruebas criptográficas unitarias | IMPLEMENTAR_AHORA |
| POST de evaluación devolvía 201 por defecto Nest | `@HttpCode(200)` en consultas físicas y barcode | IMPLEMENTAR_AHORA |
| Consulta por ID ignoraba query desconocida | Parser contractual del query completo, canal requerido | IMPLEMENTAR_AHORA |
| Taxonomy se consultaba sin Bearer | Se propaga la credencial ya validada; servicio usa listas comerciales y usuario usa recursos administrativos publicados | IMPLEMENTAR_AHORA |
| Error SQL/driver y datos administrativos en salida | Filtro Problem seguro, proyecciones explícitas y tests de no filtración | IMPLEMENTAR_AHORA |
| Elegibilidad comercial D-CAT-05/06 | Puerto aislado responde 503; no se sustituye por `estado=ACTIVO` | BLOQUEADO_ESPECÍFICO |
| Barcode D-CAT-01..04 | Entrada textual opaca, 503 para entrada válida sin asociación aprobada | BLOQUEADO_ESPECÍFICO |
| Corrección de tipo Q-06 | Cambio estructural rechazado; sin recrear producto | BLOQUEADO_ESPECÍFICO |

### Ocho operationIds de consulta

| operationId | Resultado real |
| --- | --- |
| listarProductos | Ruta, filtros, paginación y auth implementados; consulta comercial pendiente D-CAT-05/06. Lista administrativa autorizada no depende de esa política |
| obtenerProducto | Proyección comercial y canal; pendiente D-CAT-05/06 |
| consultarDatosFisicos | 200, SKU opaco, perfiles locales y no encontrados; cliente Despacho/scope exactos |
| obtenerProductoPorSlug | Proyección comercial, slug opaco y 404; pendiente D-CAT-05/06 |
| obtenerPreparacionProducto | Estado local, operation_id, código y flag calculado sin llamada síncrona a Pricing/Inventory |
| listarVariantesProducto | Paginación/estado y proyección administrativa |
| obtenerVariante | Padre/variante y 404 contractual |
| resolverCodigoBarras | Validación y auth implementadas; resolución específica bloqueada D-CAT-01..04 |

La allowlist se conserva exactamente: Marketplace/Chatbot/Retail para las lecturas
comerciales. La mención de Ventas como consumidor no concede acceso por sí sola.
El OpenAPI omite 400 en algunas lecturas con inputs que necesitan validación
(slug/listado de variantes); se registra la discrepancia sin editar el contrato.

Pruebas disponibles: dominio, JWT/JWKS, parsers, repositorios, Problem y HTTP.
La suite HTTP sustituye casos de uso para aislar rutas/auth/status; no demuestra
persistencia ni una integración Taxonomy autenticada real.

## B. #47 — doce mutaciones

Todas usan el guard de usuario `GESTOR_COMERCIAL`. No se añade un header de
idempotencia ni una versión a las rutas de variante que no los publican.

| operationId | HTTP | Implementación y límite |
| --- | --- | --- |
| crearProducto | 201 | Producto BORRADOR, colecciones, identidad por trigger, Pricing y solo Inventory simple, Outbox en una transacción; PEN/slug aprobados |
| actualizarProducto | 200 | Misma identidad, catálogo versionado, validación final activa y rollback; Q-06 aislado |
| activarProducto | 200 | Preparaciones COMPLETED y hechos completos; padre con variantes sin perfil/Inventory propio |
| desactivarProducto | 200 | INACTIVO lógico y evento; preserva estados de variantes |
| reactivarProducto | 200 | Conserva identidades y preparaciones; no emite evento inventado |
| reintentarPreparacionProducto | 202 | Admisión bajo lock, operación estable/nuevo mensaje; solo PENDING vencido con umbral explícito |
| crearVariante | 201 | SKU explícito, combinación única, BORRADOR e Inventory solamente; omitir SKU conserva frontera 503 |
| actualizarVariante | 200 | Solo atributos no identificadores, imagen y perfil; versión y estado final |
| activarVariante | 200 | No necesita padre ACTIVO, exige Inventory COMPLETED e invariantes |
| desactivarVariante | 200 | Evento SKU; última activa inactiva padre y emite ambos eventos atómicamente |
| reactivarVariante | 200 | Independiente del estado comercial del padre; no reinicializa Inventory completado |
| reintentarPreparacionVariante | 202 | Solo Inventory; mismo criterio de timeout y concurrencia |

Se reutilizan Database, CatalogTransactionManager y PostgresCatalogWriteRepository.
Bloqueos padre → variantes ordenadas → preparaciones. Las colecciones y entidad
se confirman juntas; triggers mantienen versiones. UNIQUE y constraints diferidas
son la última defensa. No se reintentan mutaciones de negocio silenciosamente.
Los errores de SKU/combinación, versión, estructura, validación y preparación se
traducen a Problem seguros; no se expone SQL ni mensaje del driver.

Idempotencia: repetir un estado ya alcanzado no genera otra actualización ni
Outbox. Activación repetida revalida autoridad. Repetir alta no se presenta como
idempotente sin una identidad contractual: la unicidad SKU impide duplicación.

Recuperación manual: el intento vigente se reconstruye de Outbox mediante cadena
causal única, no por fecha ni columna nueva. Un reintento referencia el requested
anterior; conserva operation_id y genera otro message_id. Bajo lock solo uno
gana. Se revalidan datos actuales y se conserva intención monetaria/ubicación
inmutable. COMPLETED jamás se repite. REJECTED no se declara recuperable sin
política aprobada por código; PENDING necesita umbral operativo explícito.

Pruebas PostgreSQL: se ampliaron las seis existentes a **12** en una instancia
PostgreSQL 17 con TLS y esquema oficial por suite. Nuevos casos: altas y
unicidad, rollback de edición activa/versiones, último hijo/reactivación,
reintento concurrente/stale/terminal/Inbox, confirm/relay paralelo y lecturas.
**NO EJECUTADAS** en este equipo sin Docker. No son prueba de Supabase.

## C. #48 — mensajería

| Mensajes | Estado |
| --- | --- |
| pricing.product.initialization.requested | Persistido por alta/reintento del producto; publicador real con confirm |
| inventory.sku.initialization.requested | Solo SKU simple/variante vendible; nunca padre con variantes |
| catalog.product.deactivated / catalog.sku.deactivated | Outbox transaccional de desactivación; payload mínimo de identidad conforme lifecycle |
| pricing.product.initialization.completed / rejected | Consumer tipado + Inbox + actualización de preparación |
| inventory.sku.initialization.completed / rejected | Consumer tipado + Inbox + actualización de preparación |
| taxonomy.category.updated / product-type-schema.changed / characteristic-value.updated | Handler aislado: GenericData no define efecto ejecutable suficiente |
| taxonomy.master.deactivation.check.requested / master.deactivated / master.deactivation.rejected | Protocolo completo aislado hasta payload/versión/barrera aprobados |
| catalog.master.deactivation.checked | Sin producir éxito ficticio mientras el protocolo anterior siga pendiente |
| catalog.bulk.upsert.requested / completed / rejected | Handler/resultados aislados hasta semántica Bulk tipada y aprobada |

Transporte **real amqplib**, no un cliente simulado. La configuración inyectada
se valida al arrancar. Con URL ausente, el relay no arranca y Outbox permanece
durable pendiente; no se simula publicación. No declara ni modifica topología
en el broker compartido.

Relay: una fila pendiente con FOR UPDATE SKIP LOCKED; mensaje persistente,
mandatory y confirm; published_at solo tras confirm sin return. Caída entre
confirm y commit puede repetir transporte con el mismo message_id. Un ACK del
alternate exchange no acredita llegada al consumidor final: published_at indica
aceptación de transporte, no preparación COMPLETED ni éxito funcional.

Consumer: valida envelope/v1/productor/identidad/payload y el user_id verificado
por RabbitMQ. Transacción con Inbox `(message_id,handler)`, contenido equivalente
para replay, identidad de producto/SKU/operación, correlación e intento causal.
Stale queda registrado sin cambiar estado; COMPLETED es terminal. Un rechazo de
negocio válido se confirma normalmente, sin retry técnico.

ACK solo después de commit o de publicación confirmada en retry/DLQ. Retry
técnico conserva mensaje, cuenta hasta tres y usa po.retry.x directo hacia
po.catalog.q; DLQ por po.dlx.x. Malformados y handlers bloqueados se aíslan en
DLQ con código sanitizado, sin fingir procesamiento de negocio. No se implementa
la alternativa A ni se promete exactly-once. Reconexión mediante ciclo de 2 s;
no se acredita prueba de caída/reconexión de un broker real en este entorno.

Se añadieron cinco pruebas con **un broker RabbitMQ desechable por suite**:
persistencia/confirm, alternate exchange, basic.return+confirm, retry de 30 s y
redelivery antes de resolver el caso de uso. **NO EJECUTADAS** sin Docker.
La prueba de ACK del broker sustituye el caso de uso por una promesa controlada;
la atomicidad real Inbox/estado se verifica en la suite PostgreSQL separada.
No se acredita una prueba conjunta PG+broker, ni homologación G5/Oracle.

## D. Repositorio y entrega

- SHA inicial: `ca64844` (merge normal de master). Master remoto comprobado:
  `2970df90babf2c8caa1849b179b02918fc74a005`, ya ancestro de poma.
- Cambios propios: fuentes/pruebas/documentación en `apps/catalog-svc` y solo
  `package.json`/`package-lock.json` para amqplib expresamente autorizado.
- Commits locales de código: `4cff37b` (correcciones #45/#46/#23), `9e775f8`
  (mutaciones y mensajería #47/#48). Se mantienen juntos #47/#48 porque comparten
  el registro causal de preparación y la transacción agregado/Outbox.
- El commit documental final se identifica con `git log` en poma. Este
  documento no incorpora su propio SHA para evitar una referencia circular.
- PR #125: OPEN, remoto poma `0217605`, alcance #44/DATA-002. **No push** para no
  contaminar ese PR; no se crea ni modifica PR.
- Se preservaron sin incluir los cambios ajenos en scripts/seed/mcp/catalog,
  certificado local y variables privadas. No se editan otras apps, contratos,
  migraciones históricas, librerías o infraestructura compartida.


### Archivos modificados por este bloque

- `apps/catalog-svc/AUDIT-BLOCKS-1-2.md`
- `apps/catalog-svc/README.md`
- `apps/catalog-svc/src/app.module.ts`
- `apps/catalog-svc/src/catalog-aggregate.ts`
- `apps/catalog-svc/src/catalog-amqp.spec.ts`
- `apps/catalog-svc/src/catalog-amqp.ts`
- `apps/catalog-svc/src/catalog-auth.spec.ts`
- `apps/catalog-svc/src/catalog-auth.ts`
- `apps/catalog-svc/src/catalog-domain.spec.ts`
- `apps/catalog-svc/src/catalog-domain.ts`
- `apps/catalog-svc/src/catalog-master.client.spec.ts`
- `apps/catalog-svc/src/catalog-master.client.ts`
- `apps/catalog-svc/src/catalog-message.service.ts`
- `apps/catalog-svc/src/catalog-messages.spec.ts`
- `apps/catalog-svc/src/catalog-messages.ts`
- `apps/catalog-svc/src/catalog-mutation.controller.ts`
- `apps/catalog-svc/src/catalog-mutation.input.spec.ts`
- `apps/catalog-svc/src/catalog-mutation.input.ts`
- `apps/catalog-svc/src/catalog-mutation.service.spec.ts`
- `apps/catalog-svc/src/catalog-mutation.service.ts`
- `apps/catalog-svc/src/catalog-product.policy.spec.ts`
- `apps/catalog-svc/src/catalog-product.policy.ts`
- `apps/catalog-svc/src/catalog-query.controller.ts`
- `apps/catalog-svc/src/catalog-query.repository.ts`
- `apps/catalog-svc/src/catalog-query.service.spec.ts`
- `apps/catalog-svc/src/catalog-query.service.ts`
- `apps/catalog-svc/src/commercial.controller.ts`
- `apps/catalog-svc/src/commercial.service.ts`
- `apps/catalog-svc/src/config.spec.ts`
- `apps/catalog-svc/src/config.ts`
- `apps/catalog-svc/src/postgres-catalog-write.repository.ts`
- `apps/catalog-svc/src/problem.filter.spec.ts`
- `apps/catalog-svc/src/problem.filter.ts`
- `apps/catalog-svc/src/taxonomy.client.spec.ts`
- `apps/catalog-svc/src/taxonomy.client.ts`
- `apps/catalog-svc/test/catalog-http.e2e-spec.ts`
- `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`
- `apps/catalog-svc/test/rabbitmq.e2e-spec.ts`
- `package-lock.json`
- `package.json`

## E. Ejecuciones reales

Entorno: Windows, Node/npm del workspace, HTTP aislado en loopback. TEMP/TMP de
Vitest redirigidos a carpeta temporal local por permisos del sandbox.

| Comando | Resultado |
| --- | --- |
| npm test -- --no-file-parallelism apps/catalog-svc | PASS: 25 archivos, 246 pruebas |
| npm run test:e2e -- --no-file-parallelism apps/catalog-svc | PASS parcial: 4 archivos aprobados/4 omitidos, 35 pruebas aprobadas/25 omitidas |
| npm run build:catalog-svc | PASS |
| npm test -- --no-file-parallelism | PASS: 60 archivos, 633 pruebas |
| npm run test:e2e -- --no-file-parallelism | PASS parcial: 17 archivos aprobados/8 omitidos, 519 pruebas aprobadas/78 omitidas |
| npm run typecheck | PASS después de tipar los parámetros de la política aprobada |
| npm run lint | PASS |
| npm run format:check | PASS |
| npm run build:all | PASS |
| tsc --ignoreConfig --noEmit (tres E2E nuevos/modificados, NodeNext/ES2023) | PASS |
| git diff --check | PASS |
| PostgreSQL/RabbitMQ desechables | NO EJECUTADO: Docker no instalado/disponible; OpenSSL tampoco está en PATH |
| Integración autenticada entre servicios, Supabase, CI del nuevo SHA | NO EJECUTADO |

La ejecución inicial de Vitest falló por EPERM en TEMP antes de ejecutar tests;
se resolvió redirigiendo TEMP/TMP. Typecheck detectó parámetros sin tipo en la
política nueva; corregidos y comando repetido con éxito. No hay fallos de código
obligatorios pendientes en las ejecuciones disponibles. Las omisiones no se
convierten en PASS de infraestructura; en CI las suites exigen Docker.

## F. Dependencias externas y desbloqueo verificable

| Owner que debe responder | Operación afectada | Condición concreta |
| --- | --- | --- |
| Arquitectura G6/Marco + owner poma | Elegibilidad comercial D-CAT-05/06, precioMin/Max | Política y frontera de Pricing aprobadas, contrato ejecutable y pruebas provider |
| Arquitectura G6/Marco + Retail + poma | Barcode D-CAT-01..04 | Asociación persistente y semántica de unicidad/errores aprobadas; migración si corresponde |
| Arquitectura G6/Marco + Taxonomy/lopez | Corrección de tipo Q-06 | Decisión normativa compatible que defina operación e invariantes |
| Arquitectura G6 + Pricing/vera + Inventory/taco | Retry de REJECTED | Lista o política verificable de códigos recuperables; sin asumir que todo rechazo lo es |
| Operación G6 + poma | Retry de PENDING vencido | Configurar CATALOG_PREPARATION_TIMEOUT_MS con umbral aprobado y probarlo |
| Owner producto/Gabriel | Alta de variante omitiendo SKU | Regla de generación aprobada; decisión actual exige SKU explícito |
| Arquitectura G6 + Taxonomy/lopez + Bulk/castilla | Handlers GenericData y barreras distribuidas | Payloads, versiones, intención y secuencia homologados en contratos normativos |
| Infraestructura local/CI | Evidencia PG/Rabbit y caída/reconexión | Docker/OpenSSL disponibles, ejecutar suites desechables y completar fault injection |
| Infraestructura G6/#110 + G5/#29 + Seguridad | Integración real/broker Oracle | Topología, credenciales/permisos/user_id y acuerdos de retry/DLX comprobados; homologación verificable |

Las comprobaciones HTTP y barreras locales no sustituyen el protocolo completo
de desactivación maestra entre instancias. No se atribuye aceptación externa por
silencio. No se enviaron mensajes ni se cambiaron issues/PRs para comunicarlo.

## G. Estado por issue

| Issue | Implementación interna | Pruebas locales | Integración / homologación / despliegue | Final |
| --- | --- | --- | --- | --- |
| #45 | Reglas definidas implementadas; Q-06/fronteras pendientes aisladas | Unitarias PASS, PG sin ejecutar | Sin acreditar | PARTIAL |
| #46 | Ocho rutas; política comercial/barcode específicos pendientes | Unitarias y HTTP PASS, PG sin ejecutar | Sin acreditar | PARTIAL |
| #23 | Lookup ID/slug preparado, barcode pendiente | Casos HTTP aislados PASS | Sin acreditar | PARTIAL |
| #47 | Doce rutas; SKU omitido/recuperabilidad selectiva pendientes | Unitarias/HTTP PASS, PG sin ejecutar | Sin acreditar | PARTIAL |
| #48 | AMQP real y preparación/Outbox/Inbox; GenericData aislado | Unitarias PASS, PG/broker sin ejecutar | Sin acreditar | PARTIAL |

Los bloqueos son específicos; no paralizan las mutaciones e invariantes internas
definidas. El bloque no se presenta como cierre integral de los cinco issues.
