# Plan ejecutable de implementación de Azure Service Bus en G6

Fecha: 2026-11-15. Rama de preparación: `cueva`.

Estado: **plan local propuesto**, preparado por solicitud de Axel. No acredita adopción de la ADR, autorización de archivos compartidos, implementación, pruebas runtime ni despliegue. No se publicaron Issues ni cambios en Docs remoto.

Avance 2026-11-16: se ejecutó el primer incremento con excepción expresa del usuario para Pricing/Audit/SB-01 en `cueva`, usando el Issue local. Después, por solicitud expresa de continuar con Azure real y despliegue, se creó infraestructura aislada y pasó el flujo autenticado, redelivery, RBAC cruzado y DLQ. Consultar [corte local](EJECUCION_PILOTO_SERVICE_BUS.md) y [ejecución Azure](EJECUCION_AZURE_SERVICE_BUS.md). La release en apps actuales, CI y migración compartida siguen pendientes; no se amplió el corte a otros servicios.

## 1. Resultado esperado y límites

Integrar el broker administrado Azure Service Bus con los ocho servicios existentes de G6, conservando lógica de negocio, contratos de mensajes y recuperación durable. No hace falta crear una novena aplicación de negocio que centralice el envío, el consumo o los datos de los demás servicios. Cada productor posee su Outbox; cada consumidor posee su Inbox, sus transacciones y sus handlers.

La base de trabajo propuesta es **Basic**, como en la ADR H5. La decisión interna y su alcance deben quedar registrados antes de activar el transporte. Basic exige colas por destinatario, distribución desde Outbox y deduplicación SQL. Si se requiere pub/sub administrado o red privada del broker, revisar el tier antes de aprovisionar; no prometer funcionalidades de Standard/Premium en Basic.

Dos líneas de trabajo independientes:

- **Interna G6:** adaptadores SDK, persistencia de entregas, infraestructura, piloto, migración gradual y pruebas reales. No depende de homologar nuevos endpoints con G5 para desarrollarse.
- **Frontera externa:** cambio de G5 desde AMQP a HTTP, contratos de cupones/reservas y permisos G7. Continúa como propuesta hasta resolver su contrato y aceptación. Impide retirar los flujos externos afectados, no el piloto interno.

## 2. Base comprobada

| Fuente | Corte revisado | Hallazgo |
|---|---|---|
| Backend local | `8bf6b6ecf3e60730c945fe707769f95ffa450a8e` | Rama `cueva`; dependencia `amqplib`; sin referencias a `ServiceBusClient`, SDK Azure ni `outbox_delivery` en las rutas inspeccionadas |
| Docs oficial | `0a4c333f9339c187bf68dceda20de6556124b001` | ADR/topología/operación H5 propuestas; OpenAPI `0.6.0-rc.5`; AsyncAPI `0.6.0-rc.4` |
| Pricing y Price Audit | Código local de mensajería/configuración | Relay, Inbox/persistencia de auditoría y decoder registrado; emisión de `pricing.price.changed` condicionada por flag que por defecto es `false` |
| Promotions | `src/coupons/` | Puerto `ConfirmedResultPublisher`, Outbox SQL y runtime; identidad/evidencia productiva bloqueadas explícitamente |
| ACA | `ops/azure/container-apps/render-deployment.mjs` | Configuración con `minReplicas: 0`; hay que diseñar activación del worker y recuperación del relay SQL |

Los archivos locales modificados previamente por el usuario no forman parte de este trabajo. No se inspeccionaron credenciales ni recursos Azure actuales. El inventario documental de 40 mensajes/18 relaciones no certifica handlers actuales; cada ruta se verifica contra código y prueba.

### Actualización de base al preparar el Issue — 2026-11-15

La tabla anterior conserva el corte inicial. Una nueva consulta verificó Backend oficial `48594fe708cf4a3fbc050612682e4211267daf96` (PR #232) y Docs `f77c442485203695a5e877fce188a4d249c129fb`. El checkout local sigue en `8bf6b6e`; no se sincronizó ni cambió de rama.

El master oficial **ya incluye** `@azure/service-bus@7.10.0` y `@azure/identity@4.14.1`, además del candidato Catalog (`catalog-service-bus.ts`, relay, pruebas y migración candidata de entregas). Su README mantiene pendiente la integración del escritor exclusivo H5 y el arranque del worker; las pruebas SQL descritas usan emisor simulado y no acreditan Azure real. La implementación siguiente debe aprovechar ese antecedente sin importar código entre aplicaciones, reinstalar SDK sin necesidad ni atribuir corte productivo.

La ADR y el plan H5 consultados en la nueva base continúan como propuestas. El Issue transversal listo para publicar está en [ISSUE_PILOTO_SERVICE_BUS.md](ISSUE_PILOTO_SERVICE_BUS.md). Su creación fue intentada pero no se completó por permisos/autenticación; no tiene número de GitHub.

Fuentes y cambios documentales concretos: [CAMBIOS_DOCUMENTACION_SERVICE_BUS.md](CAMBIOS_DOCUMENTACION_SERVICE_BUS.md). Issues preparados, sin números ficticios: [BACKLOG_SERVICE_BUS.md](BACKLOG_SERVICE_BUS.md).

## 3. Decisiones técnicas propuestas para cerrar en el Issue base

| Decisión | Propuesta implementable | Evidencia de cierre |
|---|---|---|
| SDK | Conservar los SDK ya fijados en master: `@azure/service-bus@7.10.0` y `@azure/identity@4.14.1`; verificar su compatibilidad al integrar el SHA autorizado | Lockfile/build y comprobación de soporte; sin reinstalación o actualización duplicada |
| Organización | Adaptadores técnicos locales por servicio en la primera entrega; sin imports entre `apps/*` | Diff y validación de dependencias. Una librería puramente técnica requiere autorización explícita adicional de `libs/` |
| Credenciales | Managed Identity propia por servicio en ACA; roles Sender/Receiver al nivel de cola | Identidad A puede hacer su operación y B no puede hacerla; sin Data Owner runtime |
| Procedencia | Cola por productor/consumidor y único conjunto autorizado de emisores, contrastado con `producer` contractual | ACL/RBAC y pruebas negativas. El envelope no autentica al emisor; el SDK no se trata como prueba automática de su identidad individual |
| Infraestructura | Bicep en `ops/azure/service-bus/`, con parámetros por entorno y manifiesto de rutas | Validación/render/what-if; aplicación real separada |
| Configuración | Nombres candidatos `MESSAGING_PROVIDER` y `SERVICE_BUS_NAMESPACE_FQDN`; catálogo versionado de rutas/destinatarios | Parseo estricto, rutas autorizadas, fallos cerrados y pruebas; no son variables actualmente implementadas |
| Compatibilidad | Mantener modo RabbitMQ existente; activar Azure solo en el flujo/conjunto de flujos aprobado | No hay fallback automático ni publicación simultánea del mismo efecto en dos brokers |
| Ejecución inicial | Una réplica mínima para componentes con relay/worker activo; cotizar el costo | Recuperación de SQL pendiente y consumo sin petición HTTP que despierte la aplicación |

Un interruptor global por servicio **no basta para el corte gradual**: Pricing también tiene inicialización y resultados para Catalog. Primero ejecutar el piloto en entorno aislado con flujos seleccionados. Para producción, el manifiesto debe seleccionar un único transporte por ruta lógica, con versión y destinatarios explícitos, o migrar coordinadamente el conjunto completo que comparta emisor/topología. La elección se registra al crear la entrega y no se cambia silenciosamente para registros pendientes.

## 4. Semántica durable que debe implementar cada servicio

### Publicación y distribución

1. En la transacción de negocio guardar el hecho inmutable y las intenciones de entrega de los destinatarios obligatorios aprobados. Referenciar el `message_id` contractual; no añadir un nuevo `event_id` al envelope sin contrato.
2. Preparar una migración aditiva de entrega por destino en el schema del productor, con unicidad de mensaje y destino lógico. Nombres/DDL definitivos se revisan en Docs y el Issue de ese servicio.
3. Conservar por entrega destino, versión de ruta, transporte seleccionado, estado, intentos y disponibilidad para reintento. Esos son datos internos propuestos, no campos nuevos del mensaje público.
4. Hacer claim durable con vencimiento y exclusión de concurrencia; enviar fuera de una transacción SQL larga y actualizar el estado solo después de confirmación positiva del SDK.
5. Si el envío es ambiguo, conservar la entrega pendiente y reusar el mismo `message_id`. Un proceso que cae después del envío y antes de registrar el resultado producirá duplicados; el consumidor debe absorberlos.
6. Una entrega fallida no borra ni repite las confirmadas de otros destinos. No declarar publicación global completada con destinatarios obligatorios pendientes.
7. El alta de un consumidor nuevo no provoca replay histórico por defecto. El manifiesto y la versión guardada determinan los destinatarios de cada hecho.

En la transición, no convertir un `published_at` histórico de RabbitMQ en evidencia de entrega Azure ni reemitir todo el histórico. Clasificar pendientes y confirmados por corte, reconciliar con Inbox/efecto y documentar el backfill autorizado.

### Consumo y disposición

1. Recibir con Peek-Lock y desactivar la finalización automática del SDK.
2. Validar tamaño, nombre, versión, envelope, coherencia de IDs y origen autorizado por la ruta antes de aplicar el handler.
3. En la transacción local registrar/verificar Inbox, ejecutar el efecto y guardar su resultado. Mantener idempotencia funcional por `operation_id` cuando el contrato la define, además de deduplicación de transporte por mensaje/handler.
4. Completar el mensaje únicamente tras commit. Si se pierde el lock o falla `completeMessage`, la siguiente entrega recupera el resultado sin duplicar el efecto.
5. Si falla una dependencia temporal, dejar la entrega recuperable con política acotada. Inválidos permanentes requieren clasificación, evidencia y DLQ/disposición durable; no ACK silencioso ni bucle infinito.
6. Configurar concurrencia y renovación de lock según duración observada. Probar pérdida de lock, cierre ordenado y réplicas concurrentes. El broker no garantiza FIFO estricto para Basic; las versiones/invariantes del agregado permanecen en el dominio.

La política H5 de retry/DLQ se adopta expresamente por flujo; no se presenta como una autorización retroactiva para cambiar la política RabbitMQ H4.

### Operación en ACA

El escalado por longitud de cola no despierta un relay cuyo único trabajo pendiente está en PostgreSQL y aún no ha llegado al broker. Para la primera entrega mantener vivos los componentes que poseen relays; si después se adopta cero réplicas, añadir un mecanismo aprobado y probado de recuperación SQL y reglas de cola para consumidores. Medir antes de aumentar réplicas; preservar claims/locks e idempotencia durante actualizaciones donde coincidan revisiones.

La liveness comprueba proceso. Readiness y observabilidad distinguen capacidad HTTP, estado de consumidor y retraso del Outbox; una operación que admite intención durable no debe fingir que el mensaje ya se publicó. Definir el contrato de readiness de cada servicio antes de cambiar probes y no agregar endpoints comerciales.

## 5. Etapas y criterios de salida

| Etapa | Entregable | Responsabilidad de ejecución según ownership vigente | Dependencias y salida verificable |
|---|---|---|---|
| P0 Plan y alcance | ADR interna delimitada, catálogo candidato H5, Issues y archivos autorizados | Axel prepara; coordinación G6 registra decisión/alcance | Base por SHA, separación de contratos externos y sin cambios de aceptación ficticios |
| P1 Infraestructura y base SDK | Bicep, RBAC, configuración y adaptadores para el piloto; diseño de entregas | Infra autorizada y Vera para Pricing/Audit | P0; validación IaC y SDK local. Azure real requiere entorno/identidades habilitados |
| P2 Piloto aislado | `pricing.price.changed` → `g6.price-audit.from.pricing` → auditoría durable | Vera | P1; filas reales en PostgreSQL, duplicados y fallos sin duplicar auditoría. No cambia flujos productivos Catalog/Promotions |
| P3 Inicializaciones | Catalog↔Pricing y Catalog↔Inventory, incluyendo todos sus resultados | Poma, Vera, Taco | P2; contratos/correlación, caídas, replay y resultado final probados por operación |
| P4 Distribución interna | Bajas Catalog y stock/precio para Combos/Promotions | Productores propietarios; Castilla en Combos; Axel en Promotions | P2 y handlers verificados; entrega/recuperación independientes. Gates de cupones se conservan |
| P5 Bulk/Taxonomy | Rutas aprobadas de maestros y cargas masivas; límite 256 KB | Castilla, Poma, Lopez, Vera, Taco según ruta | P2 y semántica de cada handler; chunking o claim-check probado por fila. Flujos BLOCKED_CONTRACT permanecen aislados |
| PX Frontera externa | Contratos HTTP H5, grants, admisión/consulta y reconciliación G5 | G6 owners + G5/G7; Gateway solo por Issue transversal | Puede diseñarse junto a P1; exposición/corte requiere contrato canónico y aceptación verificable |
| P6 Cortes y cierre | Migración por grupo de rutas, conciliación, rollback y retiro final | Coordinación/infra y owners concernidos | Cada grupo tiene pruebas y autorización; RabbitMQ solo se retira cuando no conserva dependencias, incluidas las externas |

Secuencia interna mínima: P0 → P1 → P2; luego P3/P4/P5 según sus dependencias verificadas. PX no es prerrequisito del piloto ni de la implementación interna. El cierre completo P6 sí exige resolver los consumidores externos que todavía dependan de RabbitMQ.

### Entrega mínima del piloto

- Una cola aislada de prueba `g6.price-audit.from.pricing`, con identidad emisora y receptora distintas.
- Operación real de Pricing que persista cambio y Outbox; relay SDK; decoder productivo ya registrado en Audit; commit de auditoría e Inbox antes del settlement.
- Entrega encolada y pendiente SQL visibles; prueba de caída antes del envío, envío ambiguo, caída post-commit y recuperación.
- `PRICING_PRICE_CHANGED_PUBLISH_ENABLED` se configura explícitamente para el piloto; no se presupone activo por el cambio de proveedor.
- Sin muestras productivas de compradores; datos descartables y namespace de prueba autorizado. Emulador y Azure real se reportan por separado.
- La prueba no declara migradas otras rutas del emisor ni desbloqueado Promotions.

## 6. Archivos y límites de la primera implementación

| Paquete | Rutas existentes de entrada | Adiciones candidatas, sujetas al Issue |
|---|---|---|
| Dependencias comunes | `package.json`, `package-lock.json` | Los SDK ya están fijados en master; tocar solo ante necesidad adicional autorizada, sin actualizaciones ajenas |
| Pricing | `apps/pricing-svc/src/messaging/outbox-relay.ts`, `src/config/environment.ts`, `src/persistence/pricing.schema.ts` | Adaptador Service Bus, repositorio de entregas y pruebas dentro de `apps/pricing-svc/` |
| Price Audit | `apps/price-audit-svc/src/messaging/audit-consumer.ts`, `src/config/environment.ts`, `src/price-audit-svc.module.ts` | Consumidor SDK y pruebas; preservar `price-change-decoder.ts`/persistencia salvo necesidad autorizada |
| Infra | `ops/azure/container-apps/render-deployment.mjs`, preflight y pruebas relacionadas | `ops/azure/service-bus/` para Bicep, manifiesto y parámetros de ejemplo sin secretos |
| Promotions, etapa P4/PX | `apps/promotions-svc/src/coupons/`, `src/infrastructure/config/`, `src/health/` | Adaptadores, Inbox/Outbox y pruebas propias; admisión HTTP solo tras contrato aprobado |
| Docs oficial | ADR/topología/plan/pruebas y modelos de datos de los servicios afectados | Candidata de transporte H5 separada y migraciones aditivas cuando el modelo esté revisado |

Son rutas para delimitar Issues, no permisos ya concedidos. En `cueva` se prepara documentación y se implementa Promotions dentro del Issue autorizado. Los cambios en Pricing/Audit corresponden a `vera`; las dependencias, infraestructura y Gateway necesitan autorización de alcance explícita. No crear ramas automáticas ni concentrar cambios de otros owners en `cueva`.

## 7. Pruebas y definición de terminado

| Nivel | Evidencia necesaria | Casos H5 relacionados |
|---|---|---|
| Documental | Contratos, rutas y estados coherentes; fixtures H4 preservados; enlaces y versiones verificados | H5-DOC-01 y validaciones de catálogo |
| Unitario | Configuración, traducción SDK, coherencia de IDs, clasificación de errores, cierre | Parte local de H5-MSG-02/04/08/09 |
| Persistencia real aislada | Transacción negocio+entregas, claim vencido, dos relays, Inbox/efecto atómicos y replay | H5-MSG-02/03/04/05 |
| Emulador | Cableado SDK y escenarios compatibles; límites del emulador identificados | H5-MSG-19 |
| Azure real | Managed Identity/RBAC por cola, permiso denegado, DLQ, locks, reconexión y tamaño | H5-MSG-01/02/03/04/06/07/08 |
| E2E por flujo | Emisor real → SQL → broker → consumidor real → efecto durable | H5-MSG-01/05/09; PX añade 10–18 y 21–33 aplicables |
| Operación | Recuperación SQL sin tráfico HTTP, revisión/restart, corte, rollback y replay auditado | Ampliar plan H5 con casos propuestos nuevos, sin afirmar ejecución |
| Rendimiento/costo | Throughput, backlog/edad, latencia, fallos, conexiones SQL y estimación regional | H5-MSG-20; umbrales acordados antes de aceptar |

Para cada PR de implementación: pruebas enfocadas primero; después `npm test`, `npm run test:e2e`, `npm run typecheck`, `npm run lint`, build de servicios tocados y comprobaciones del workflow aplicable. Tests Docker/emulador/Azure se ejecutan con su comando registrado en el Issue, no como un PASS implícito del comando general.

Registrar ID de prueba, SHA Backend/Docs, versión contractual, entorno, identidad no secreta, fecha, dataset, comando, salida, omisiones y responsable. Mantener separados: decisión interna, implementación, CI, integración autenticada, homologación externa y despliegue. Ningún comando de implementación se ejecutó durante la preparación de este plan.

## 8. Corte, compatibilidad y rollback

1. Inventariar por familia de mensaje todos los consumidores/bindings actuales, mensajes en vuelo, pendientes SQL y dependencias G5. Un exchange RabbitMQ puede distribuir a más consumidores que el piloto Azure.
2. Preparar todos los destinatarios obligatorios del grupo aprobado y verificar compatibilidad de los consumidores antes de cambiar al productor.
3. Fijar checkpoint del corte y suspender/serializar la adquisición del grupo afectado; drenar o clasificar los mensajes en vuelo. Conservar intenciones de negocio durables mientras dure la ventana.
4. Activar una sola ruta de entrega funcional para el grupo; registrar manifiesto, SHA y versiones. No cambiar todos los flujos del servicio por un flag sin comprobar su alcance.
5. Reconciliar Outbox, entregas, Inbox y efectos. Revisar duplicados, destinatarios faltantes y mensajes de ambas topologías antes de declarar éxito.
6. Si se revierte, detener el nuevo envío, identificar mensajes aceptados/en vuelo y reconciliar antes de restaurar el transporte anterior. Un rollback de binario no deshace efectos de negocio; mantener schema aditivo y deduplicación.
7. No borrar colas, Inbox, entregas o el broker anterior como parte del rollback. El retiro final requiere inventario sin dependencias y plan aprobado.

## 9. Dependencias específicas

| Responsable requerido | Operación afectada | Condición concreta de desbloqueo |
|---|---|---|
| Coordinación G6/Marco | Activación de transporte interno y alcance compartido | Registrar decisión interna H5 e Issue que autorice SDK/lockfile, IaC y archivos transversales exactos |
| Infra Azure | Integración real, identidades y consumo continuo | Namespace/colas de prueba autorizados, región/SKU y presupuesto comprobados, RBAC por entidad y configuración de ejecución verificable |
| Vera | Piloto Pricing/Audit | Issue ejecutado en `vera`, SHA de ambos componentes y pruebas con persistencia real |
| Productores Catalog/Pricing/Inventory + Axel | Proyecciones y runtime de Promotions | Verificar handlers/contratos actuales, identidad por ruta y evidencia/eligibilidad autoritativa; no retirar el gate por cambiar broker |
| G5 y G6 owners | Nueva frontera HTTP y retiro AMQP externo | Acuerdo de DTO/estados/reintentos/secuencia/reconciliación y prueba bilateral por SHA |
| G7 | Autorización HTTP G5 | Scopes/allowlists definidos y grants reales probados por operación; no equivalen a Azure RBAC |
| Owner de cada dominio masivo | Operaciones hoy BLOCKED_CONTRACT | Contrato de negocio cerrado y handler implementado/probado; aprovisionar una cola no satisface la condición |

## 10. Primer paquete listo para registrar

Preparar en este orden los Issues SB-00, SB-01, SB-02 y SB-03 del [backlog](BACKLOG_SERVICE_BUS.md): alcance documental, SDK/infra, persistencia/adaptadores del piloto y prueba real Pricing→Audit. SB-* son identificadores locales de planificación, no números de GitHub.

La preparación documental puede avanzar ahora. La implementación interna se clasifica `IMPLEMENTAR_PARCIAL` hasta registrar decisión/alcance y resolver únicamente sus dependencias aplicables. La frontera externa permanece `BLOQUEADO_ESPECÍFICO`; no bloquea escribir y probar el adaptador interno autorizado.

Referencias Microsoft verificadas el 2026-11-15: [tiers](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-premium-messaging), [cuotas](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-quotas), [identidad/RBAC](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-managed-service-identity), [escalado ACA](https://learn.microsoft.com/en-us/azure/container-apps/scale-app). La aplicación de IaC y la concesión de permisos no forman parte de esta preparación.
