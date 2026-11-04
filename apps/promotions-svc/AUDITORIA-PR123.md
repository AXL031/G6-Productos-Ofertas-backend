# Correcciones de auditoría del PR #123

Rama `cueva`. Base auditada `b7c1a99a5b93ad8ef97878a24b3fe563323dc2da`.
Se integra mediante merge normal `origin/master` en
`47e219e376fff1004ec10e9803c16119c811a699`, sin conflictos. Se conservan los
cambios aprobados de master y los propios de Promotions. El lockfile y
package.json no tenían cambios nuevos en master; CI conserva los jobs nuevos
de master y el job PG/TLS y smoke de contenedor propios de Promotions.
No se editan ni regeneran contratos, migraciones, ACL o configuración Oracle.

## Alcances y estados

| Alcance | Desarrollo interno | Integración | Homologación | Despliegue |
| --- | --- | --- | --- | --- |
| #71 persistencia propia | IMPLEMENTADO_LOCAL, Drizzle/repositorios/transacciones de 13 tablas | INTEGRACION_BLOQUEADA para entorno compartido, TLS/rol por comprobar allí | HOMOLOGACION_PENDIENTE de entrega | DESPLIEGUE_NO_EJECUTADO |
| #72 reglas | IMPLEMENTADO_LOCAL para alternativas individuales/exclusivas; composición candidata aislada | INTEGRACION_BLOQUEADA para composición y fuentes comerciales | HOMOLOGACION_PENDIENTE de fórmula y consumidores | DESPLIEGUE_NO_EJECUTADO |
| #73 consultas | IMPLEMENTADO_LOCAL, rutas/DTOs/auth y cliente comercial candidato | INTEGRACION_BLOQUEADA para lecturas comerciales reales autorizadas | HOMOLOGACION_PENDIENTE | DESPLIEGUE_NO_EJECUTADO |
| #74 escrituras | IMPLEMENTADO_LOCAL para invariantes, persistencia y HTTP | INTEGRACION_BLOQUEADA en altas/ediciones/activaciones dependientes de referencias | HOMOLOGACION_PENDIENTE de frontera autorizada | DESPLIEGUE_NO_EJECUTADO |
| #75 eventos | IMPLEMENTADO_LOCAL, dispatcher/Inbox/writers | INTEGRACION_BLOQUEADA: faltan cuatro decoders externos e identidad/ACL | HOMOLOGACION_PENDIENTE de mensajes/topología | DESPLIEGUE_NO_EJECUTADO |
| #70/#76 salud | IMPLEMENTADO_LOCAL, liveness, probes PG/broker opt-in y observación | INTEGRACION_BLOQUEADA para readiness comercial/despliegue | HOMOLOGACION_PENDIENTE de operación/readiness | DESPLIEGUE_NO_EJECUTADO |
| #77 frontend | IMPLEMENTADO_LOCAL en frontend `10dd0e23974cb29dd12b57d716286aef711562c1`, PR frontend #56 | INTEGRACION_BLOQUEADA para G7/servicios compartidos | HOMOLOGACION_PENDIENTE | DESPLIEGUE_NO_EJECUTADO |
| #78 pruebas | IMPLEMENTADO_LOCAL, runners reales descartables y casos de contrato explícitos | INTEGRACION_BLOQUEADA para flujo compartido | HOMOLOGACION_PENDIENTE bilateral | DESPLIEGUE_NO_EJECUTADO |

Estas etiquetas describen dimensiones distintas, no cierre de issues. La
fuente autorizada de hechos #33 y los decoders externos #75 aún requieren
programación cuando se resuelvan sus contratos/permisos. #15 y #112 siguen
siendo preparación DATA/dry-run: sin cargas ni restauraciones compartidas.

## Fronteras que se conservan

**Referencias #74.** `ADMIN_REFERENCES` sigue siendo `blockedAdminReferences`.
Los selectores de navegador no prueban existencia/actividad. No se consulta
directamente ningún schema ajeno. Los tests del puerto interno cubren producto,
SKU y categoría inexistentes, inactivos, identidad inconsistente y timeout
abortado en crear/editar/activar. Las invariantes se comprueban por HTTP firmado
y PostgreSQL/TLS descartable, verificando cero modificaciones de agregados,
usos o mensajería en los casos rechazados. Son fixtures explícitos del puerto,
no homologación de un DTO externo ni implementación del adaptador productivo.

**Composición #72.** Dos beneficios compatibles siguen provocando rechazo
explícito `CommercialDependencyError`, aunque cada alternativa individual sea
calculable. No se elige una de ellas silenciosamente. `benefit-composition.ts`
y la proyección monetaria candidata permanecen aislados del HTTP productivo.
El gate requiere decisión G6 sobre fórmula de acumulación, distribución del
descuento fijo, redondeo/escala y semántica de `promotion_id`, y confirmación de
compatibilidad con consumidores. #72 sigue parcial.

**AMQP #33/#75.** `COUPON_RUNTIME_BOUNDARY.assertReady` conserva su rechazo
incondicional incluso si se satisfacen los preflights de dispatcher/identidad.
No se activa `PROMOTIONS_COUPON_RUNTIME_ENABLED`, no se registra evidencia ni
decoders sintéticos y el registro de adaptadores continúa vacío. Se conservan
ACK posterior a commit, idempotencia y rollback técnico sin ACK; los runners
prueban reentrega con broker real descartable. Antes de habilitar faltan fuente
autorizada de reserva/snapshot, cuatro decoders tipados, identidad/ACL, pruebas
bilaterales y condiciones de recuperación. No se aprovisiona el broker compartido.

**D-04.** Existe una diferencia deliberada entre el perfil bilateral H4 del
emisor G5 (envía siempre `consumption_operation_id`) y el esquema general
AsyncAPI `0.6.0-rc.3` (opcional/anulable). El acuerdo vigente declara expresamente
que rc.3 se conserva y no requiere versión nueva por ese perfil de emisor.
Se documentan ambas reglas; no se cambia AsyncAPI, los schemas generados ni el
parser. Los tests de conformidad prueban referencia original válida,
inexistente, ajena al pedido, replay idéntico y duplicado con intención alterada,
sin doble efecto ni liberar otro consumo. La aceptación documental D-04 no
acredita la implementación conjunta: faltan versiones/commits del productor G5
y prueba bilateral. Un cambio futuro del contrato general requiere publicación
y homologación verificables; no se endurece aquí.

**Salud #70/#76.** `/health` es exclusivamente liveness; `200` solo prueba que
el proceso atiende. `PromotionsReadinessService.check()` registra PG y broker
y puede indicar `ready` para esas dependencias, mientras referencias y lecturas
comerciales siguen bloqueadas. Ninguno es readiness funcional de Promotions.
No existen endpoints contractuales `/health/live` ni `/health/ready`; siguen
404. El healthcheck genérico heredado de master no acredita disponibilidad
comercial: antes de desplegar, Marco/infra debe definir y autorizar la señal
operativa por alcance, con pruebas de dependencias y gates comerciales. No
usar `/health=200` ni probes PG/broker como autorización de release/tráfico.

## Dependencias y desbloqueos verificables

| Owner | Operación | Condición exacta |
| --- | --- | --- |
| Poma/Lopez + Marco/G7 | Validación administrativa #74 | Operación e identidad propia autorizadas, grants/allowlists y prueba autenticada de existencia/actividad de producto, SKU y categoría. |
| Marco/arquitectura G6 y consumidores afectados | Composición #72 | Aprobar fórmula, asignación de descuento fijo, redondeo/escala y `promotion_id`; publicar compatibilidad contractual verificable. |
| G5/Inventario/Taco + Marco/G7 | Evidencia #33 | Fuente contractual autorizada de reserva confirmada y condiciones comerciales durables completas; identidad propia y prueba bilateral. |
| Poma/Vera/Taco + Marco | Decoders #75 | Publicar campos, versiones y semántica de snapshot; implementar y probar decoders conformes. GenericData no basta. |
| G5 + Marco/infra #29 | Consumo/restauración AMQP | Identidad/ACL/red/vhost/bindings y recuperación acordados, productor por versión y prueba bilateral; sin habilitar por pruebas aisladas. |
| G5 + arquitectura G6 | D-04 | Acreditar productor que envía referencia original y payload estable; ejecutar conjuntamente los casos de conformidad de restauración/replay. |
| G7 + integración G6 | Sesión compartida #77 | URL, CORS/orígenes, issuer/JWKS/roles reales y prueba autenticada. |
| Marco/infra #111 | Readiness y despliegue | Señal de disponibilidad por alcance aprobada y probada, gates cerrados y autorización individual de SHA/imagen/destino. |
| Owners comerciales/DATA + Marco | #15/#112 | Referencias/precios/lotes/hashes reconciliados y autorización explícita antes de cualquier carga/restore persistente. |

## Evidencia y fuentes

El SHA candidato, comandos/resultados, omisiones, CI exacta y enlaces de esta
corrección se registran en PR #123 y en los issues #71–#78 tras las ejecuciones.
Los resultados del HEAD previo no se atribuyen al merge. Los runners dedicados
guardan SHA/estado del árbol; el flujo conjunto registra además hashes de fuentes.
No se cierra ningún issue ni se hace merge del PR, que permanece OPEN/DRAFT.

Fuentes oficiales: Docs G6 `1ee0d9e5a788dbe559a376bf96a60c6117af3956`,
OpenAPI `0.6.0-rc.1`, AsyncAPI `0.6.0-rc.3`, SPEC-005/006/007,
DEC-F-007/008/009/012 y matrices de trazabilidad/intermodular;
`integraciones/ACUERDO_G5_G6_H4_2026-10-21.md`, especialmente compatibilidad D-04.
Las guías de `ops/oracle/` heredadas conservan observaciones históricas y
versiones anteriores; no se reinterpretan como homologación ni estado actual.
