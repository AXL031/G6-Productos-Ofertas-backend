# Integración H5 en el fork

Base oficial b1edcf7fe70e98354239290fb5847c49c75d9107. Contratos OpenAPI y AsyncAPI 0.7.0-rc.1, Docs df0b09c651fab7f8fcdc693211109573f5e39a12. Esta rama reúne trabajo para validarlo por flujo con la principal como base.

El fork incorpora el borrador Catalog #243 en el SHA 9c448044d9903b79a823e30a74d009123b23a44f. Esta incorporación preserva sus tres commits para la integración local. El estado de revisión continúa en el PR original.

## Evidencia local

- R13 usa el emisor `InventoryServiceBusRelay` con un evento generado por `OutboxService.stockChanged` y el receptor de Promotions. La prueba conecta ambos extremos en la frontera del SDK y aplica las migraciones históricas verificadas de Promotions en PostgreSQL descartable. Cubre resultado de invalidación, pérdida de confirmación y reentrega después de reiniciar el receptor. El transporte SDK de esta prueba es un doble.
- R08 acepta el formato del publicador Catalog sin espejos AMQP de producer/schema_version/route_version. Si están presentes, se validan. La prueba local y la prueba Azure descrita abajo verificaron baja de SKU, orden de versión y replay.
- R17 añade una entrega independiente por destino para `pricing.price.changed`. Si falla la entrega de Promotions, Price Audit aún puede confirmar la suya. Este comportamiento se comprobó en el laboratorio con ambos consumidores y la migración aditiva en PostgreSQL descartable.
- R05/R12 tienen un receptor H5 de Combos que reutiliza el handler y la identidad de Inbox de H4, con complete después del commit. Azure validó baja de SKU y cambio de stock. La baja por producto depende además de la lectura HTTP autenticada de Catalog.
- R07/R15 usan el receptor Azure de Pricing para inicialización y baja de SKU. El resultado tiene una entrega durable hacia Catalog. Una prueba en PostgreSQL envía el sobre producido por Catalog, repite su entrega y valida con el parser oficial de Catalog un único resultado con la correlación y la causación originales.
- R06/R11 conservan la versión inicial de saldo 0 definida por el modelo de Inventory. El resultado de inicialización se entrega a Catalog. En H5 la inicialización en cero no publica `inventory.stock.changed`, cuyo contrato exige una versión positiva. Las mutaciones posteriores conservan su publicación por destino. La recepción R06 valida también correlación exacta y UTF-8.
- R04 tiene receptor en Bulk para resultados de Catalog. Se selecciona con `MESSAGING_PROVIDER=AZURE_SERVICE_BUS` y `BULK_SERVICE_BUS_CATALOG_RESULTS_ENABLED=true`, con su identidad Receiver en `g6.bulk.from.catalog`. El laboratorio comprobó la persistencia y conciliación de resultados de lotes previamente admitidos.
- R01 tiene código candidato para guardar el documento de filas y el comando V3 en una sola transacción, enviar el comando por Service Bus y conciliar R04 con el mismo lote. El [cierre de R01](CIERRE_R01_R04_CARGA_MASIVA.md) describe los permisos y las pruebas exigidas antes de habilitar la ruta y el emisor.
- R09/R18 tienen runtime H5 del lado Taxonomy. El receptor conserva la correlación y la barrera del handler existente. La migración candidata marca el transporte al crear el hecho y registra la entrega durable al mismo tiempo. El relay H5 envía fuera de la transacción y retiene el MessageId ante un timeout. H4 conserva sus pendientes propios y excluye las filas de H5.
- N01 usa los schemas de OpenAPI actuales y valida igualdad de snapshot ref con order_id. El controlador y el worker de producción siguen detrás del cierre de G5/G7 y de una fuente autorizada de las evidencias.

```powershell
npm test -- --maxWorkers=2 apps/promotions-svc apps/inventory-svc/src/messaging apps/pricing-svc
npm test -- --maxWorkers=2 apps/combos-svc
npm test -- --maxWorkers=2 apps/taxonomy-svc
node apps/promotions-svc/test/run-h5-postgres.mjs inventory
node apps/promotions-svc/test/run-h5-postgres.mjs
node apps/promotions-svc/test/run-h5-postgres.mjs taxonomy
$env:G6_SERVICE_BUS_POSTGRES_TESTS='1'
npm run test:e2e -- --maxWorkers=1 tests/h5/pricing-fanout.postgres.e2e-spec.ts ops/azure/service-bus/pilot.postgres.e2e-spec.ts
```

En esta base pasaron las suites focalizadas de Promotions, Inventory y Pricing, 77 unitarias de Combos, 19 E2E de Promotions, 3 pruebas de SQL de cupones y 2 pruebas R08/R13 contra PostgreSQL descartable. Los 9 casos de SQL de Pricing incluyeron el fan-out y la regresión del piloto. Pasaron typecheck, builds de Pricing/Promotions/Combos y lint con cuatro avisos preexistentes. La plantilla compiló y el listado de 19 colas coincide con el AsyncAPI de la revisión fijada. Azure real y los flujos de G5/G7 requieren evidencia propia.

Taxonomy añadió 344 pruebas unitarias y dos casos de integración aprobados. El test SQL usa el rol runtime y verifica selección de transporte por sesión, exclusión de las filas H5 del publicador H4 y reintento con el mismo MessageId. El segundo caso usa un doble del store para comprobar validación y orden de settlement del resultado de Catalog. Pasaron también build de Taxonomy y formato.

Con Catalog #243 integrado, pasaron 91 pruebas focalizadas de Catalog, Inventory y Bulk. La prueba bilateral de Pricing más la regresión del piloto pasó 10 casos con PostgreSQL descartable. Pasaron también typecheck, formato, lint con las cuatro advertencias preexistentes y builds de Catalog, Pricing, Inventory y Bulk.

El CI del fork sobre 45659be detectó que el parser de Catalog rechazaba eventos válidos de Taxonomy con causation_id u operation_id omitidos. La corrección conserva esos campos como opcionales en el sobre general y mantiene las comprobaciones obligatorias para los resultados de inicialización. Pasaron los 27 casos focalizados de Catalog y Taxonomy. La suite opcional de Inventory aprobó sus diez casos H5 con PostgreSQL y el SQL oficial fijado por SHA.

En la validación del 19 de noviembre volvieron a pasar las 136 pruebas focalizadas de mensajería de Inventory y Bulk y del servicio Combos. Con PostgreSQL local descartable también pasaron diez pruebas de Pricing y la regresión del piloto, dos de Taxonomy y los dos casos locales de Catalog/Inventory hacia Promotions. Los dos casos opcionales con Service Bus se ejecutaron por separado en Azure.

## Publicación de imágenes del fork

El [CI del candidato](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44393762229) aprobó 21 jobs para `827476c97e37cf8a5c9a196e287c3d3b4f2acdd9`. La [publicación del fork](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44540226297) construyó las ocho imágenes de mensajería con ese SHA como tag, verificó las etiquetas OCI y confirmó los siguientes digests en `ghcr.io/axl031/g6-productos-ofertas-backend/<servicio>`.

| Servicio | Digest |
| --- | --- |
| Bulk | `sha256:1af60ae055d731926a48a31499e5e630cbc8faa016132cb98c1849ae030e24b6` |
| Catalog | `sha256:7cae671db7d68ab42dd715a98aa0dfc812f298d43a71e996dc76ce08b076673d` |
| Combos | `sha256:e43bfd904587fc37293e99679ffcb51b72bd87dd06058c686c74a8f25284c1cd` |
| Inventory | `sha256:435643548a9498b8d47a144ba4502f6a63ba793081906efce8a08e331eb2dd73` |
| Price Audit | `sha256:b9f7b7d973824fc996dad89c624c3397a9c1b0916c9a26e58f7baaf6393e34d7` |
| Pricing | `sha256:6d25a8005effe2b834e8a48ebe9dddfc70214a9f25aa9d0f961350182a7923b5` |
| Promotions | `sha256:3794c03bc16b4559dae7fe5b4f01a8e53d3f39fc8af5a96c23cef51647f6a9b1` |
| Taxonomy | `sha256:5b492897991a28ae3796d92b46a76b8b0f0d61e89b47de401fa2c64413e722a2` |

## Laboratorio Azure

`ops/azure/service-bus/h5-integration.bicep` define un namespace Basic independiente en el grupo de recursos de integración, colas escogidas por ID de flujo, identidades de workload y roles Sender/Receiver en cada cola. Usa autenticación Microsoft Entra, TLS 1.2 y métricas de backlog y DLQ. Infra revisa red, acceso del runner, retención, umbrales y destinatarios de alertas antes de desplegar. La salida de la plantilla contiene identificadores de identidad, no credenciales.

Revisar el plan de Azure con el grupo de integración antes de crear recursos. Para R13, Inventory registra también la entrega a Combos por R12. Proveer esa cola si se usa el runtime emisor completo en laboratorio o usar el relay de prueba focalizado en R13. Mantener la activación compartida separada del laboratorio. Para R16/R17 seleccionar ambos flujos y ejecutar envíos independientes con sus roles.

El smoke opt-in de R13 está en `tests/h5/inventory-promotions.postgres.e2e-spec.ts`. Desde un runner Azure autorizado con las dos identidades de laboratorio asignadas y acceso a PostgreSQL descartable, establecer `PROMOTIONS_H5_POSTGRES_TESTS=1`, `PROMOTIONS_H5_TEST_DATABASE_URL` con el nombre local exigido por el test y `G6_H5_R13_REAL_AZURE=1`. Introducir `G6_H5_LAB_NAMESPACE_FQDN` y los dos identificadores públicos de cliente `G6_H5_LAB_INVENTORY_CLIENT_ID` y `G6_H5_LAB_PROMOTIONS_CLIENT_ID` de la salida de la plantilla. Ejecutar `npm run test:e2e -- --maxWorkers=1 tests/h5/inventory-promotions.postgres.e2e-spec.ts -t 'R13 uses the laboratory broker'`. El smoke exige un namespace de laboratorio e identidades diferentes. Comprueba acceso Sender/Receiver, denegación de Receiver con la identidad de Inventory y dos confirmaciones del broker con un solo Inbox. Utiliza datos sintéticos.

El 19 de noviembre de 2026 se desplegó R13 en Azure for Students, región Chile Central, grupo `rg-g6-sb-h5-int-fork`, namespace `g6-sb-h5-int-32cdqgbnlk7ow` y cola `g6.promotions.from.inventory`. La prueba pasó con el código fuente fijado y volvió a pasar con los binarios extraídos por Azure de los dos digests anteriores. El runner de esa ejecución informó `G6_H5_R13_AZURE_PASS` y un caso aprobado en Vitest. La cuenta final de mensajes activos y en DLQ fue cero y se retiraron los dos runners temporales. El namespace, la cola y sus identidades quedan disponibles como laboratorio.

La plantilla `ops/azure/service-bus/h5-promotions-runner.bicep` reproduce R13 y admite R08 al recibir la identidad y el digest de Catalog. Usa PostgreSQL 17 descartable, un límite de tiempo y ningún ingress. La ejecución registra `G6_H5_PROMOTIONS_AZURE_PASS`, el SHA de la suite y los casos Vitest aprobados. Fijar por separado los digests de las imágenes y el SHA del archivo fuente de las pruebas.

La ejecución conjunta usó la suite `fdc554eb30425dd109e5a35e90bf1b595403c094` y los digests de Catalog, Inventory y Promotions del candidato `827476c`. En R08, tres entregas (versión 3, versión 2 y repetición de la versión 3) dejaron dos registros completos de Inbox y conservaron la proyección de versión 3. R13 volvió a pasar. Las colas `g6.promotions.from.catalog` y `g6.promotions.from.inventory` terminaron con cero mensajes activos y cero en DLQ. Se retiró el runner y se verificó que el grupo quedó sin contenedores. Quedaron el namespace Basic, las dos colas, las identidades de laboratorio y sus permisos. El CI de la suite y del runner aprobó 21 jobs. [CI del SHA de pruebas](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44542847846)

Estas pruebas ejecutan los componentes de mensajería compilados de Catalog, Inventory y Promotions. Quedan pendientes el arranque completo de las aplicaciones en el ambiente destino, la disponibilidad de sus dependencias autenticadas y el corte operativo.

Un `what-if` posterior validó que las diez colas de R05/R06/R07/R09/R11/R12/R15/R16/R17/R18 se crearían dentro del mismo grupo de laboratorio. La vista previa terminó sin eliminaciones ni reemplazos. Esta verificación precedió a los despliegues y las pruebas registradas abajo.

### Inicializaciones, baja maestra y entregas de Pricing

La primera prueba de inicializaciones reprodujo un error real de arranque de Inventory con `inventory_app`. La vista `information_schema.constraint_column_usage` oculta las tablas de otro propietario. El commit `c3cb185dbd488084f8101535a3b30fc0eb19461f` comprueba la clave foránea exacta en el catálogo de PostgreSQL, sin ampliar el rol y sin cambiar migraciones. El CI aprobó el SHA y la regresión arrancó con `inventory_app` sin membresía del propietario. Se publicó solo Inventory. [CI de la corrección](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44557493168) · [Publicación de Inventory](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44558413410)

El digest vigente de Inventory para estas pruebas es `sha256:f419fb7d762d98ff15a53fc9b6d293ed61e8f38e6ca33679316ce926e3cf2915`. Catalog, Pricing, Taxonomy, Price Audit y Promotions se fijaron por los digests de la publicación original.

R08 y R13 volvieron a pasar con el digest vigente de Inventory, los digests originales de Catalog y Promotions y la suite `fdc554eb30425dd109e5a35e90bf1b595403c094`. El runner reprodujo el rechazo RBAC y las comprobaciones de Inbox y versión descritas arriba.

| Flujos | Evidencia en Azure |
| --- | --- |
| R06/R11 · Catalog ↔ Inventory | Saldo inicial en cero con ubicación válida y rechazo durable por ubicación inexistente. Reentregas inducidas tras commit en Inventory y Catalog. Un resultado correlacionado por solicitud y baja de SKU aplicada una vez. |
| R07/R15 · Catalog ↔ Pricing | Precio inicial persistido y rechazo durable de una recuperación histórica sin vigencia. Reentrega después del commit en ambos extremos, un resultado de inicialización por solicitud y baja SKU deduplicada. |
| R09/R18 · Catalog ↔ Taxonomy | Categorías `CLEAR` e `IN_USE` con estado terminal durable. Reentrega del resultado de Catalog sin duplicar el efecto. La barrera siguió activa hasta el evento terminal correlacionado. |
| R16/R17 · Pricing → Price Audit y Promotions | Un solo hecho con dos entregas. Al interrumpir el envío a Promotions, Audit confirmó el suyo. El reintento confirmó Promotions y ambas reentregas dejaron un solo efecto persistido por consumidor. |
| R05/R12 · Catalog e Inventory → Combos | R05 baja de SKU y R12 invalidación del stock proyectado, con reentrega después del commit, un Inbox por evento y conservación de la marca de baja tras el cambio de stock. |
| R04 · Catalog → Bulk | Resultados de éxito y rechazo correlacionados con lotes sintéticos previamente admitidos. Reentrega después del commit y una sola fila de Inbox por resultado. Ninguna orden de importación publicada. |

La suite bilateral `4031bb2884349eb9bc50d15ae85200a6a9b1d6cc` aprobó cuatro casos en Azure, incluidos dos casos de preparación y readiness. El ensayo anterior dejó un único comando sintético de Pricing, que se identificó y completó por su MessageId antes de la corrida final. La suite de fan-out `2a0983245ef2bdf39c2cec38eb11715349243e6a` aprobó dos casos en Azure, incluido el fixture SQL. Los runners quedaron retirados y las colas terminaron con cero mensajes activos y cero en DLQ.

La suite de Combos `9eb420163d513b8346173b2d374fe186bd8872be` aprobó dos casos en Azure. El fixture creó un combo con dos componentes en una transacción, como exige la migración oficial. Las dos entregas de negocio fueron confirmadas tras su reentrega y conservaron una sola fila de Inbox por evento.

La suite R04 del commit `d511e04b51db19477e6a413d5802a2fbd8e0e5ca` aprobó dos casos en Azure con Catalog y Bulk fijados por digest. Usó el emisor de Catalog para el sobre canónico y el receptor de Bulk para aplicar y confirmar ambos resultados. El caso local adicional verificó la conciliación y deduplicación sobre PostgreSQL descartable.

El laboratorio quedó con 13 colas, cero mensajes activos, cero en DLQ y cero contenedores de prueba al cerrar esas suites. La prueba de tipos focalizada cubrió las cuatro suites nuevas. [CI del SHA final de pruebas](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44564412703)

La ejecución posterior de R01 y R04 añadió `g6.catalog.from.bulk` y dejó 14 colas de laboratorio. La actualización sintética pasó con ambas colas en Service Bus Basic, PostgreSQL descartable, JWT de prueba y los digests nuevos de Bulk y Catalog. Las dos reentregas conservaron un solo efecto por consumidor. [Evidencia de R01 y R04](CIERRE_R01_R04_CARGA_MASIVA.md)

## Dependencias para completar el corte

| Flujo | Condición verificable |
| --- | --- |
| R06/R07/R11/R15 | Trasladar al ambiente destino las migraciones y grants validados en el laboratorio y comprobar el arranque completo de los servicios |
| R05/R12 | R05 baja de producto requiere comprobar Catalog HTTP autenticado y el grant efectivo `catalogo:leer` para Combos. R05 baja SKU y R12 ya se probaron en el laboratorio |
| R09/R18 | Completar la cobertura en Azure de las demás entidades maestras y comprobar el arranque autenticado en el ambiente destino |
| R16/R17 | Comprobar arranque, grants y activación del fan-out en el ambiente destino |
| R01/R04 | Castilla y Poma revisan el candidato probado en Azure. G7 e Infra acreditan el grant y la ruta HTTPS privada en el destino, y la capacidad para los documentos y resultados del lote |
| R02/R03/R10/R14 | Bulk, Inventory y Pricing deben versionar los payloads de comandos y resultados y validar el circuito completo por destino dentro del límite Basic |
| N01 y frontera externa | Homologación G5, grants verificados G7, evidencia reserva/snapshot, rutas autenticadas Gateway/APIM y conciliación durable G5 |
| Corte y retiro H4 | CI del SHA candidato, migraciones y RBAC por ambiente, E2E Azure, recuperación, aprobación operativa y reconciliación de pendientes antes de retirar RabbitMQ |

## Orden para evaluar el corte

1. Fijar los SHA del fork y de Docs. En el laboratorio, desplegar el plan de las colas seleccionadas con sus identidades, ejecutar el smoke de R13 y registrar el namespace y las evidencias de envío, rechazo por RBAC, Inbox y reentrega.
2. Reproducir las pruebas de inicialización, R04, Combos, Taxonomy y fan-out según la evidencia anterior. Registrar las variantes y dependencias autenticadas pendientes para el ambiente destino.
3. Para cada productor, conciliar Outbox e Inbox del transporte anterior antes de habilitar el nuevo. Para una reversión, detener el emisor nuevo y clasificar sus intenciones pendientes o ambiguas por MessageId, destino y estado de negocio. Cambiar proveedor solo después de reconciliar esos pendientes y acordar cómo aislar los hechos ya enviados. La reversión no es un replay automático del Outbox histórico.
4. Mantener los flujos de Bulk dependientes de contratos y la frontera externa G5/G7 cerrados hasta su validación. La publicación a la principal, los grants y la retirada de RabbitMQ se hacen en una fase posterior al trabajo de esta rama.

Fuentes: [matriz H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/df0b09c651fab7f8fcdc693211109573f5e39a12/integraciones/MATRIZ-IMPLEMENTACION-SERVICE-BUS-H5.md), [Inventory #240](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/240), [Catalog #243](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/243), [Gateway e Infra #242](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/242), [G5 #64](https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/64) y [G7 #107](https://github.com/Taller-SW-Web/Modulo-de-Seguridad/issues/107).
