# Promotions para Marketplace — código, contratos y pruebas

**IMPLEMENTADO_LOCAL; integración comercial real PARTIAL.** Rama `cueva`, issues
#72/#73/#78, PR #182. No se solicita cerrar esos issues ni hacer merge.

## Correcciones y alcance auditado

Las cuatro consultas ya tienen implementación HTTP/persistente y motor de negocio.
Se corrigen dos brechas del transporte: conservar `X-Correlation-Id` de la solicitud
en todas las lecturas comerciales y usar el mismo instante UTC para reglas y precios
de recomendaciones. El contexto es por solicitud, sin estado mutable compartido.
El wrapper transmite contexto y cancelación del padre junto con su deadline.
No cambian DTOs, allowlists, scopes, contratos compartidos ni reglas monetarias.

Composición v1 permanece conectada a `evaluateBasket` y al HTTP: compatibilidad
bilateral, descuentos sucesivos, mejor subconjunto, prioridad/ID estables, fijo
una vez, reparto proporcional y redondeo final half-up PEN escala 2. Las consultas
usan transacción `REPEATABLE READ READ ONLY`; el consumo del cupón continúa en su
flujo de comandos separado. No hay un consumidor AMQP acreditado por estas consultas.

Fuentes aplicables: SPEC-005/006/007, DEC-F-002/005/006/007/008/009/012 y
DEC-G6-INT-01/02/03/04/05; acuerdos G1 y paquete operativo Marketplace leídos.
La comparación automatizada comprueba rutas, métodos, security, clientes, scopes,
audience, query/body/response y errores de las cuatro operaciones.

## Cortes y evidencias

| Elemento                                                    | Revisión exacta / evidencia                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Implementación y scripts de Promotions                      | `dec96b80075bc183397271ea2373ef9f9e115986`                                                                             |
| Proveedores reales Catalog/Pricing/Inventory/Taxonomy       | Backend `7f1ffc1f1f490861ef55ed3d84757d05954a2d33`, master verificado al ejecutar                                      |
| OpenAPI normativo más reciente revisado                     | Docs `4d285c5ffb91611b60385e0fab5a7295c95e3ed6`, rc.3; [auditoría](test/evidence/marketplace-contract-2026-11-04.json) |
| Código actual del consumidor con proveedores reales         | [61 escenarios y hashes](test/evidence/marketplace-real-2026-11-04.json)                                               |
| Módulo nativo, PostgreSQL real y hechos comerciales fixture | [19 escenarios HTTP y trazas](test/evidence/marketplace-native-2026-11-04.json)                                        |
| Suite PostgreSQL/TLS completa                               | [30 grupos PASS](test/evidence/marketplace-persistence-2026-11-04.json)                                                |
| Equivalencia entre ejecución y commit                       | [89 fuentes + siete archivos del harness + helper nativo](test/evidence/marketplace-provenance-2026-11-04.json)        |

La ejecución real conserva su `checkoutHead=92c1660` y la lista original de fuentes
modificadas. **No se ejecutó ese código antiguo:** el harness compiló el worktree
actual y montó su `dist/apps/promotions-svc` sobre el dist de proveedores archivados.
La auditoría posterior verificó byte por byte las 89 fuentes y scripts ejecutados
contra `dec96b8`; no reescribe el HEAD histórico ni simula un rerun en otro SHA.
El SHA final y su CI están en la descripción de [PR #182](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/182).

Las migraciones del harness real siguen verificadas por blob contra Docs `80f2089`
y las de Promotions contra `51a5ce6`; son migraciones históricas inmutables. El
avance posterior `4d285c5` trata el perfil físico G2; se repitió la comparación de
Marketplace con ese OpenAPI y las cuatro operaciones coinciden. No se presentan
los snapshots `20146a50` ni Promotions `33054c3` como la implementación actual.

## Matriz por operación de Promotions

Todos los positivos internos usan el código `dec96b8`. En la columna real se usa
ese consumidor con proveedores `7f1ffc1`; los identificadores son `checks[].id`.

| Operación / endpoint                                                                    | Negocio local: HTTP + JWT + PostgreSQL + adaptadores nativos                                                                                               | Integración con proveedores reales                                                      | Evidencia y bloqueo                                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `listarPromociones` GET `/api/v1/promociones?canal=MARKETPLACE`                         | **PASS**: campaña vigente de canal, DTO contractual; filtros/vigencia en suite de consultas                                                                | **PASS**, HTTP 200 y campaña persistida                                                 | `promotions-real-list-active-campaign`; sin dependencia comercial                      |
| `evaluarPromociones` POST `/api/v1/promociones/evaluar`                                 | **PASS**: regular 100, oferta vigente 80, automática 10% y cupón 10% → 64.80; descuento 35.20; principal automático por prioridad                          | **BLOCKED** para positivo; **PASS** en fallo seguro 503 por 403 trazado de Catalog      | `promotions-real-http-catalog-403-fails-closed`; Poma, después dataset activo con Vera |
| `validarCupon` POST `/api/v1/cupones/validar`                                           | **PASS**: mismo cupón solo sobre oferta permitida → 72.00, identidad real de su campaña; código desconocido → `CUPON_NO_ENCONTRADO`                        | **BLOCKED** para positivo; **PASS** en 503 contractual correlacionado                   | `promotions-real-coupon-catalog-403-fails-closed`; Poma/Vera                           |
| `obtenerRecomendaciones` GET `/api/v1/recomendaciones?productoId=...&canal=MARKETPLACE` | **PASS**: producto con variantes, disponibilidad positiva, mínimo vigente 20.00; stock indeterminado o precio ausente excluyen; precio vencido o 403 → 503 | **BLOCKED** para positivo; **PASS** en 503 por Catalog antes de consultar stock/precios | `promotions-real-recommendations-catalog-403-fails-closed`; Poma/Taco/Vera y grant G7  |

Los importes 64.80/72.00/20.00 son resultados con **fixtures comerciales explícitos**
y no son una prueba positiva contra Catalog/Pricing/Inventory reales. Producción
no fabrica precios, disponibilidad ni elegibilidad ni sustituye una falla técnica
por recomendaciones vacías. Los vacíos de negocio requieren ausencia contractual
confirmada o stock indeterminado, no un 401/403/timeout/DTO corrupto.

## Matriz por proveedor real y condición de desbloqueo

Todos estos proveedores pertenecen al SHA `7f1ffc1f1f490861ef55ed3d84757d05954a2d33`.
Los JWT son RS256 locales con `sub=modulo-productos`, `aud=api-productos` y scope
de cada operación; modo demo desactivado. Esto no acredita un grant G7 real.

| Servicio / operación                 | Endpoint                                                                     | Resultado observado                                                                                                               | Estado / evidencia                                                                                                                              | Responsable y desbloqueo verificable                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog / contexto SKU               | GET `/api/v1/productos/skus/{sku}/contexto`                                  | 200 con identidad canónica; controles de inactivo/ausente/401/403, reinicio y persistencia                                        | **PASS** `catalog-context-simple-real-pg`, `promotions-native-token-reader-to-real-catalog`                                                     | Poma: sin bloqueo de esta operación local                                                                                                                   |
| Catalog / producto comercial         | GET `/api/v1/productos/{id}?canal=MARKETPLACE`                               | 403 `SCOPE_INSUFICIENTE` por cliente no autorizado                                                                                | **BLOCKED** `blocker-catalog-product`                                                                                                           | Poma: fusionar permiso por operación para modulo-productos sin relajar JWT ni negativos, proporcionar SKU activo                                            |
| Pricing / precio vigente             | GET `/api/v1/precios/skus/{sku}?canal=MARKETPLACE&at=...`                    | 404 `PRECIO_NO_ENCONTRADO` al SKU no elegible; lote devuelve 200 sin ítems                                                        | **PASS** negativos; **BLOCKED** positivo, `pricing-real-catalog-inactive-sku-contract-error`, `pricing-real-catalog-batch-omits-ineligible-sku` | Poma + Vera: SKU activo confirmado y precio vigente en el mismo canal/instante; no se atribuye a Pricing un 403 que no se observó                           |
| Inventory / disponibilidad comercial | GET `/api/v1/inventario/disponibilidad/comercial?skus=...&canal=MARKETPLACE` | 403: cliente modulo-productos no autorizado; control Marketplace clasifica estados reales                                         | **BLOCKED** `blocker-inventory-commercial`; control `inventory-real-pg-four-commercial-states`                                                  | Taco: PR fusionada de GET/cliente/canal MARKETPLACE según adenda, conservando rechazos de scope/canal/POST. No se suplanta Marketplace ni se cambia Gateway |
| Taxonomy / categoría por ID          | GET `/api/v1/categorias/{categoriaId}`                                       | 200 activa/inactiva, 404 inexistente y negativos 401/403; consumidor Nest real distingue referencia válida/ausente/inactiva/fallo | **PASS** `taxonomy-category-*`, `promotions-nest-taxonomy-reference-*`                                                                          | López: bloqueo local de ruta resuelto por PR #181; G7 compartido sigue pendiente                                                                            |

La evidencia exacta de Inventory incluye `El cliente 'modulo-productos' no está
autorizado para esta operación`. La responsabilidad del guard del proveedor no
se traslada a Gateway ni se utiliza el bypass demo. Se conservan abiertos los
issues de integración; no se publicó ningún comentario a otros responsables.

## Autorización, consistencia y efectos secundarios

`obtenerRecomendaciones` permite Marketplace/Chatbot/Retail con
`recomendaciones:leer` en OpenAPI. El registro
`x-security-contract.service_scopes_pending_registration` solo enumera Chatbot.
La prueba comprueba esa divergencia y los guards existentes, sin ampliar permisos.
**Marco/G7** deben reconciliar el registro y acreditar concesión/credenciales para
Marketplace. Ni la allowlist, ni el inventario pendiente, ni un JWT de prueba
demuestran que el grant real exista o haya sido denegado.

Las 19 solicitudes nuevas verifican DTO/status, correlación entrante/saliente,
token propio por scope y el mismo instante de consulta. Se prueban reintentos de
evaluación/validación con cupón limitado a un uso global y por cliente sin gastar
el cupo: igualdad completa de filas de **todas** las tablas de Promotions, no solo
conteos. Todas las solicitudes a proveedores comerciales son GET; no hay comandos
de reserva/consumo. Esto no atribuye observación de un servicio de reservas externo.

Se conservan límites HTTP de 2500 ms, máximo 1 MiB, redirects rechazados y fallos
sanitizados sin reintentos implícitos. Las regresiones cubren concurrencia sin
mezclar correlaciones, cancelación y errores de identidad/precio/moneda/vigencia.
La prueba real de PostgreSQL observa query/PID bloqueado, `TimeoutError` idéntico
a `signal.reason` a 2005 ms, libera su lock por ROLLBACK y verifica drenado e
HTTP recuperado. No afirma que abortar HTTP cancele automáticamente la query SQL.

Readiness: PG y RabbitMQ son descartables; la comprobación del broker se ejecuta
en una **instancia independiente** de readiness. El monitor HTTP tiene broker
desactivado y `PROMOTIONS_COUPON_RUNTIME_ENABLED=false`. No se acredita consumo
AMQP operativo, RabbitMQ compartido, E2E comercial completo, homologación ni despliegue.

## Validación ejecutada

| Comando                                                                                                   | Resultado                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm test -- apps/promotions-svc --maxWorkers=1`                                                          | **378 PASS**, 32 archivos                                                             |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1`                                                  | **11 PASS**, dos archivos                                                             |
| `node apps/promotions-svc/test/persistence.isolated.smoke.mjs`                                            | **30 grupos PASS**, incluye 19 escenarios nuevos nativos y composición HTTP/PG        |
| `node apps/promotions-svc/test/real-services.isolated.e2e.mjs`                                            | **61 PASS**, cero FAIL; resultado global PARTIAL por positivos comerciales bloqueados |
| `node --test apps/promotions-svc/test/support/real-services-assertions.test.mjs`                          | **12 PASS**                                                                           |
| `node apps/promotions-svc/test/marketplace-contract.audit.mjs <openapi.json>`                             | **4 operaciones PASS**, OpenAPI rc.3 de `4d285c5`                                     |
| `node apps/promotions-svc/test/marketplace-provenance.audit.mjs dec96b80075bc183397271ea2373ef9f9e115986` | **PASS**, fuentes y harness coinciden con commit                                      |
| `npm run typecheck`, `npm run lint`, `npm run build:promotions-svc`                                       | **PASS**                                                                              |
| Build de proveedores `npm run build:all` en snapshot                                                      | **PASS**                                                                              |
| Prettier de archivos modificados y `git diff --check`                                                     | **PASS**                                                                              |

CI ejecuta la suite PostgreSQL de Promotions, incluyendo el nuevo helper nativo.
Los 61 escenarios con proveedores reales se ejecutaron localmente; no se
atribuyen al workflow general. La CI por SHA final se publica en la PR.

Para reproducir: desde la raíz con `npm ci`, Docker y OpenSSL disponibles,
compilar Promotions y ejecutar los comandos anteriores. El harness real archiva
el master fijado y construye el runtime si falta. PowerShell puede configurar
`G6_TEST_OPENSSL` con la ruta de OpenSSL de Git. No cargar `.env.local` ni recursos
Supabase/Oracle compartidos. El auditor contractual recibe JSON parseado del YAML
oficial de `4d285c5`; valida el blob `6ff062c563d381d4bcf7976f223590b400ace4ec`
del YAML contiguo. Los JSON se pueden formatear con Prettier después del runner.

Se registran los fallos del desarrollo del harness: fixture con customer_ref no
UUID, prioridad empatada con ID aleatorio y Problem Details 404 sin `status`;
corregidos sin debilitar contratos. El harness real detectó salida JSON mezclada
con logs del monitor en el seed y un helper JWT usado antes de inicializarse;
corregidos. Las ejecuciones finales completas no omiten escenarios.
El fallo histórico inicial de CI de PR #172 (Docker/OpenSSL preflight, run
41678108613 intento 1; intento 2 verde sin cambio de código) continúa documentado
en la evidencia anterior y no se elimina ni se presenta como fallo funcional nuevo.

La red, los diez contenedores propios, volúmenes y certificados de la ejecución
real fueron retirados. No se modificó código ajeno, contratos, Gateway ni datos
compartidos. Estado interno listo para revisión; cierre comercial H4 pendiente
de los positivos y credenciales descritos por operación.
