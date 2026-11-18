# Integración H5 en el fork

Base oficial b1edcf7fe70e98354239290fb5847c49c75d9107. Contratos OpenAPI y AsyncAPI 0.7.0-rc.1, Docs df0b09c651fab7f8fcdc693211109573f5e39a12. Esta rama reúne trabajo para validarlo por flujo con la principal como base.

El fork incorpora el borrador Catalog #243 en el SHA 9c448044d9903b79a823e30a74d009123b23a44f. Esta incorporación preserva sus tres commits para la integración local. El estado de revisión continúa en el PR original.

## Evidencia local

- R13 usa el emisor `InventoryServiceBusRelay` con un evento generado por `OutboxService.stockChanged` y el receptor de Promotions. La prueba conecta ambos extremos en la frontera del SDK y aplica las migraciones históricas verificadas de Promotions en PostgreSQL descartable. Cubre resultado de invalidación, pérdida de confirmación y reentrega después de reiniciar el receptor. El transporte SDK de esta prueba es un doble.
- R08 acepta el formato del publicador Catalog sin espejos AMQP de producer/schema_version/route_version. Si están presentes, se validan. La prueba local con publicación de Catalog y persistencia Promotions verificó la baja SKU, el orden de versión y el replay. Falta repetir con el runtime del #243 y los permisos Azure.
- R17 añade una entrega independiente por destino para `pricing.price.changed`. Si falla la entrega de Promotions, Price Audit aún puede confirmar la suya. Se proponen una migración aditiva y configuración separada del piloto R16. Falta aplicar la migración en un entorno autorizado y probar ambos destinos con Azure y los dos consumidores.
- R05/R12 tienen un receptor H5 de Combos que reutiliza el handler y la identidad de Inbox de H4, con complete después del commit. Verificar en Azure ambas colas y el permiso HTTP de lectura de Catalog que usa la baja por producto.
- R07/R15 usan el receptor Azure de Pricing para inicialización y baja de SKU. El resultado tiene una entrega durable hacia Catalog. Una prueba en PostgreSQL envía el sobre producido por Catalog, repite su entrega y valida con el parser oficial de Catalog un único resultado con la correlación y la causación originales.
- R06/R11 conservan la versión inicial de saldo 0 definida por el modelo de Inventory. El resultado de inicialización se entrega a Catalog. En H5 la inicialización en cero no publica `inventory.stock.changed`, cuyo contrato exige una versión positiva. Las mutaciones posteriores conservan su publicación por destino. La recepción R06 valida también correlación exacta y UTF-8.
- R04 tiene receptor candidato en Bulk para resultados de Catalog. Se selecciona con `MESSAGING_PROVIDER=AZURE_SERVICE_BUS` y `BULK_SERVICE_BUS_CATALOG_RESULTS_ENABLED=true`, con su identidad Receiver en `g6.bulk.from.catalog`. Usa la persistencia y conciliación que ya existen. La admisión de importaciones en H5 permanece cerrada hasta resolver R01 y comprobar la ruta privada de contenido y los resultados correlacionados.
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

## Laboratorio Azure

`ops/azure/service-bus/h5-integration.bicep` define un namespace Basic independiente en el grupo de recursos de integración, colas escogidas por ID de flujo, identidades de workload y roles Sender/Receiver en cada cola. Usa autenticación Microsoft Entra, TLS 1.2 y métricas de backlog y DLQ. Infra revisa red, acceso del runner, retención, umbrales y destinatarios de alertas antes de desplegar. La salida de la plantilla contiene identificadores de identidad, no credenciales.

Revisar el plan de Azure con el grupo de integración antes de crear recursos. Para R13, Inventory registra también la entrega a Combos por R12. Proveer esa cola si se usa el runtime emisor completo en laboratorio o usar el relay de prueba focalizado en R13. Mantener la activación compartida separada del laboratorio. Para R16/R17 seleccionar ambos flujos y ejecutar envíos independientes con sus roles.

El smoke opt-in de R13 está en `tests/h5/inventory-promotions.postgres.e2e-spec.ts`. Desde un runner Azure autorizado con las dos identidades de laboratorio asignadas y acceso a PostgreSQL descartable, establecer `PROMOTIONS_H5_POSTGRES_TESTS=1`, `PROMOTIONS_H5_TEST_DATABASE_URL` con el nombre local exigido por el test y `G6_H5_R13_REAL_AZURE=1`. Introducir `G6_H5_LAB_NAMESPACE_FQDN` y los dos identificadores públicos de cliente `G6_H5_LAB_INVENTORY_CLIENT_ID` y `G6_H5_LAB_PROMOTIONS_CLIENT_ID` de la salida de la plantilla. Ejecutar `npm run test:e2e -- --maxWorkers=1 tests/h5/inventory-promotions.postgres.e2e-spec.ts`. El smoke rechaza el namespace del piloto y exige identidades diferentes. Comprueba acceso Sender/Receiver, denegación de Receiver con la identidad de Inventory y dos confirmaciones del broker con un solo Inbox. Utiliza datos sintéticos. Su estado en esta rama es preparado; la ejecución Azure queda pendiente del laboratorio.

## Dependencias para completar el corte

| Flujo | Condición verificable |
| --- | --- |
| R06/R07/R11/R15 | Completar integración bilateral en Azure para inicializaciones, bajas y resultados durables. R07/R15 tienen evidencia de persistencia y compatibilidad de sobres local |
| R05/R12 | Prueba bilateral de emisor y receptor en Azure, con efecto único ante una entrega repetida |
| R09/R18 | Aplicar migración candidata del lado Taxonomy y probar ambos lados con el runtime Catalog, incluida la barrera de baja en Azure |
| R01–R04/R10/R14 | Contratos Bulk pendientes, ruta de contenido privado aprobada y E2E por destino dentro de 256 KB de Basic |
| N01 y frontera externa | Homologación G5, grants verificados G7, evidencia reserva/snapshot, rutas autenticadas Gateway/APIM y conciliación durable G5 |
| Corte y retiro H4 | CI del SHA candidato, migraciones y RBAC por ambiente, E2E Azure, recuperación, aprobación operativa y reconciliación de pendientes antes de retirar RabbitMQ |

## Orden para evaluar el corte

1. Fijar los SHA del fork y de Docs. En el laboratorio, desplegar el plan de las colas seleccionadas con sus identidades, ejecutar el smoke de R13 y registrar el namespace y las evidencias de envío, rechazo por RBAC, Inbox y reentrega.
2. Probar R06/R07/R11/R15 con Catalog, Inventory y Pricing. Incluir resultado de inicialización aceptada, rechazo, reentrega, correlación y caída después del commit. Después verificar R04, Combos y el ciclo de bajas de Taxonomy.
3. Para cada productor, conciliar Outbox e Inbox del transporte anterior antes de habilitar el nuevo. Para una reversión, detener el emisor nuevo y clasificar sus intenciones pendientes o ambiguas por MessageId, destino y estado de negocio. Cambiar proveedor solo después de reconciliar esos pendientes y acordar cómo aislar los hechos ya enviados. La reversión no es un replay automático del Outbox histórico.
4. Mantener los flujos de Bulk dependientes de contratos y la frontera externa G5/G7 cerrados hasta su validación. La publicación a la principal, los grants y la retirada de RabbitMQ se hacen en una fase posterior al trabajo de esta rama.

Fuentes: [matriz H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/df0b09c651fab7f8fcdc693211109573f5e39a12/integraciones/MATRIZ-IMPLEMENTACION-SERVICE-BUS-H5.md), [Inventory #240](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/240), [Catalog #243](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/243), [Gateway e Infra #242](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/242), [G5 #64](https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/64) y [G7 #107](https://github.com/Taller-SW-Web/Modulo-de-Seguridad/issues/107).
