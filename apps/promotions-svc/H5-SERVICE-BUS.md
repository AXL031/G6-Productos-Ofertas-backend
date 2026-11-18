# Promotions H5 eventos internos y preparación de cupones

Fecha 2026-11-18. Trabajo de Promotions en la rama de integración H5 del fork, relacionado con Backend #75/#242 y con el piloto #234/#235 como antecedente.

## Fuentes y estados

Verificación sobre Docs df0b09c651fab7f8fcdc693211109573f5e39a12, OpenAPI y AsyncAPI 0.7.0-rc.1 (SEMIFINAL_G6), SPEC-005/006 y DEC-F-007/008/009/012. Las guías Oracle se conservan como referencia operativa H4.

- IMPLEMENTAR_AHORA: receptor SDK de los cuatro eventos asignados, tres colas internas, selección explícita, aislamiento de transporte, integración del dispatcher existente y readiness interna.
- IMPLEMENTAR_PARCIAL: núcleo candidato de admisión, consulta, relay y worker de cupones. Es código ejecutable por sus puertos, con persistencia SQL candidata y pruebas; no se registra como controlador o worker Nest productivo.
- BLOQUEADO_ESPECIFICO: publicación de rutas G5, nombres/grants nuevos G7, fuente autoritativa de reserva/snapshot, aplicación SQL compartida y activación Azure. Los owners/condiciones se detallan abajo.

## Entrega uno eventos internos

service-bus-events.ts compone el SDK con PromotionsAssignedEventDispatcher y los adapters H4 actuales. Catalog mantiene los writers de proyección y el guard de versiones SQL. Pricing/Inventory mantienen las invalidaciones durables en Inbox; no se inventan precios ni disponibilidad agregada desde un evento de stock físico.

| Cola | Productor esperado | Eventos |
|---|---|---|
| g6.promotions.from.catalog | catalog-svc | catalog.product.deactivated, catalog.sku.deactivated |
| g6.promotions.from.pricing | pricing-svc | pricing.price.changed |
| g6.promotions.from.inventory | inventory-svc | inventory.stock.changed |

Infra debe comprobar Sender exclusivo por cola y Receiver de Promotions. Se validan cola, nombre y productor del sobre, MessageId, correlationId, subject, contentType y schema_version. Si el emisor duplica producer/schema_version/route_version en propiedades del broker, se exige que coincidan con el sobre o la versión de ruta; esas propiedades no otorgan identidad.

Se verifican los enlaces seleccionados antes de suscribirse. Peek-Lock con autoCompleteMessages=false y un handler concurrente por cola. El commit de Inbox/proyección o invalidación precede a complete. Un fallo SQL abandona el mensaje y un sobre de transporte inválido se envía a DLQ. El fn_begin_inbox normativo compara el sobre de entregas repetidas.

Los probes periódicos revalidan enlace; readiness interna observa el worker seleccionado. No se añade ruta HTTP de readiness. El cierre drena suscripciones/tareas y cierra recursos SDK en onModuleDestroy antes del pool SQL en onApplicationShutdown.

## Variables respaldadas por el parser

| Variable | Comportamiento |
|---|---|
| MESSAGING_PROVIDER | Ausente/RABBITMQ conserva H4; AZURE_SERVICE_BUS selecciona H5; otro valor falla |
| SERVICE_BUS_NAMESPACE_FQDN | Host Azure exacto, sin esquema/path/credenciales |
| PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED | true explícito para iniciar los consumidores; no habilita cupones |
| PROMOTIONS_SERVICE_BUS_EVENT_QUEUES | Permite una lista explícita de colas aprobadas separadas por coma. Al omitirse, se seleccionan las tres colas |
| G6_SERVICE_BUS_PRODUCTION_ENABLED | true obligatorio en producción H5; se rechaza true en desarrollo/test |
| AZURE_CLIENT_ID | Identidad administrada explícita obligatoria en producción; cuando se define no hay fallback a usuario CLI |
| G6_SECURITY_MODE | Producción H5 exige G7_AUTHENTICATED; no acredita grant real |
| RABBITMQ_URL | Debe estar ausente en selección Azure; no se acepta un segundo transporte |
| PROMOTIONS_COUPON_RUNTIME_ENABLED | El runtime H4 debe permanecer false en H5 |
| PROMOTIONS_DEPENDENCY_PROBES_ENABLED | Habilita monitor/probes existentes; usar true en validación operativa |

Se conservan PG/TLS, puerto, upstreams y configuración de auth existentes. El pool usa verify-full/CA; no se lee ni publica configuración privada. No habilitar esta configuración sobre el namespace piloto ni en apps compartidas sin su revisión y evidencia de RBAC/productores.

## Entrega dos núcleo candidato de admisión y resultado

Las rutas están en la baseline OpenAPI 0.7.0-rc.1. Se generaron los schemas de esa versión y la admisión exige commercial_snapshot_ref exactamente igual a order_id. Los scopes de la baseline son cupones:consumir, cupones:restaurar y cupones:operaciones:leer. Los grants efectivos, la homologación externa y la exposición HTTP permanecen pendientes.

- prepareCouponH5Admission valida DTO candidato, actor que deberá provenir de G7, UUID de correlación y clave de idempotencia. Restauración candidata exige la referencia al consumo original sin cambiar la compatibilidad H4.
- CouponH5Operations.admit toma el lock de operación compatible con el procesador existente, compara fingerprint/actor/intención y compromete operación+Outbox en la misma transacción. Devuelve solo después del commit. Replay usa el recurso y MessageId originales.
- También verifica los receipts históricos H4: otro fingerprint falla; un resultado terminal compatible se recupera sin encolar otro comando. Resultados históricos incompletos/incoherentes siguen siendo fallo técnico, no éxito supuesto.
- get usa operación, pedido y actor en la misma consulta. Recurso ajeno y ausente dan la misma ausencia al futuro adaptador. No publica ni reejecuta.
- CouponH5DeliveryStore reclama con SKIP LOCKED, lease de 30 s y token; envía fuera de la transacción SQL. Finaliza solo con token/lease vigentes. Envío ambiguo conserva intención e ID. El límite completo se comprueba con tryAddMessage del SDK.
- Sobretamaño conserva la intención con MESSAGE_TOO_LARGE y reintento infinito deshabilitado; requiere revisión operativa. El rechazo síncrono o tamaño admitido de la futura API debe cerrarse contractualmente, sin convertir esto en un rechazo de cupón inventado.
- CouponH5Worker exige correspondencia con la admisión persistida y usa CouponCommandProcessor existente, incluyendo límites, reserva, snapshot, restauración y receipt. No reemplaza CouponEvidenceProvider por fixtures.
- Processor compromete efecto, receipt y resultado Outbox juntos. Después se persiste el snapshot H5 antes de completar el mensaje interno. Si falla ese segundo commit, la reentrega recupera el receipt sin otro efecto.
- El resultado íntegro se conserva internamente; la vista candidata elimina campos no publicados como cupon_id.
- Las filas de resultados en el Outbox histórico se conservan. No se marca published_at ni se enciende el pump AMQP en H5; su clasificación/retención es parte del corte, no un backfill implícito.

La cola candidata de comandos es g6.promotions.commands, solo para adaptador/worker internos Promotions. CouponH5DeliveryHandler acepta ese destino y valida metadatos y la admisión SQL. No se concede acceso a G5 al bus.

El worker candidato deliberadamente no está registrado en producción: primero se requiere un facts source real, contratos/scopes y un diseño de arranque/recuperación operativa aprobado. No se declara funcionalidad pública por la existencia de estas clases.

## SQL candidato y prueba reproducible

migrations-candidate/h5/0001_coupon_http_operations.sql agrega únicamente h5_coupon_operations y h5_coupon_outbox. No edita históricos y no se ejecuta en bootstrap. No se aplicó a Supabase ni otro entorno compartido.

Antes de una migración definitiva, revisar modelo/ledger, owner y grants mínimos, retención, índices y compatibilidad. La cuenta runtime no debe tener DDL. Cualquier exposición de schema/RLS se revisa con el owner de datos; el candidato no autoriza acceso público.

Prueba opt-in solo contra base local VACÍA y descartable cuyo nombre comience g6_promotions_h5_test_. El test rechaza otra ubicación/nombre y un schema promotions ya presente. No elimina la base automáticamente.

Con Docker disponible, el runner crea una base local descartable y elimina únicamente su propio contenedor, previa comprobación de su etiqueta:

~~~powershell
node apps/promotions-svc/test/run-h5-postgres.mjs
~~~

Para una base local descartable administrada manualmente:

~~~powershell
$env:PROMOTIONS_H5_POSTGRES_TESTS='1'
$env:PROMOTIONS_H5_TEST_DATABASE_URL='<URL privada de la base local descartable>'
npm run test:e2e -- apps/promotions-svc/test/coupon-h5.postgres.e2e-spec.ts --maxWorkers=1
~~~

La prueba SQL cubre rollback de operación/intención, reclamo concurrente, token inválido, lease vencido y envío no confirmado. Su receipt histórico es una fixture técnica mínima; no acredita todo el negocio de cupones. Las pruebas con dobles unitarios no se presentan como PostgreSQL o Azure reales.

## Coordinación ya enviada

- G5: https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/64
- G7: https://github.com/Taller-SW-Web/Modulo-de-Seguridad/issues/107
- Gateway/BFF/Infra G6: https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/242

El conector de GitHub respondió 403; los mismos pedidos se publicaron mediante GitHub CLI autenticado. Los cuerpos locales están en h5/SOLICITUD_REVISION_G5.md, SOLICITUD_REVISION_G7.md y SOLICITUD_GATEWAY_INFRA.md.

No se atribuyen respuesta, aceptación, grant ni compromiso de otros owners a la apertura de un issue.

## Dependencias de cierre

| Responsable | Frontera | Condición concreta |
|---|---|---|
| G5/G6 Docs | Tres rutas de cupones | Homologar schema, retención, polling, errores/tamaño; incorporar candidata versionada |
| G7 | HTTP | Definir scopes/allowlists y probar emisión/autorización real; no reutilizar cupones:validar |
| G5/Inventory/G6 | Reserva y snapshot | Fuente autorizada con hechos durables verificables; mientras tanto evidencia sigue bloqueada |
| Arquitectura/integración G6 | BFF y productores compartidos | Resolver todos los destinatarios/handlers requeridos antes del corte |
| Infra/owners | Azure | Namespace/colas/identidades/RBAC por ambiente, prueba positiva/negativa, alerts/DLQ y recuperación sin tráfico |
| Owner datos/QA | SQL | Revisar modelo/grants y validar el runtime de negocio completo antes de aplicación compartida; suite transaccional local ejecutada |

El PR Inventory #240 se consultó como trabajo concurrente; no se modifica ni se considera fusionado o aceptado por esta entrega.

## Publicación y operación

Mantener este diff separado del piloto y de cambios previos del checkout. La evidencia marketplace-native-2026-11-04.json preexistente está fuera del cambio. No usar git add . ni publicar la historia antigua de cueva como si fuera un incremento limpio.

Publicar/revisar el código, aplicar SQL, provisionar Azure, configurar/reiniciar apps y efectuar el corte son acciones separadas. No se hizo deploy, cambio de grant, activación de campaña, replay ni modificación de mensajes/datos productivos.

Antes de activar: tokens reales G7, evidencia real de SQL/Azure, productores compatibles con metadatos y sus destinatarios completos; después pruebas de caída/reinicio, duplicados, pérdidas de confirmación, resultados tardíos y transición sin RabbitMQ supuesto como fallback.

## Verificación

Los resultados ejecutados y sus límites se registran al terminar en h5/VALIDACION.md. Liveness/lecturas públicas no acreditan los estados pendientes de este documento.
