# #47–#49 — respuestas del equipo y corrección de correlación

Base: `poma@57b50cc`, que ya contiene los tres commits de #50
(`042c930`, `b5c110b`, `57b50cc`). Se conservan sus guards, filtros globales,
validación administrativa y pruebas Gateway. Ownership: Gabriel Poma,
solo `apps/catalog-svc`. Respuestas comunicadas por el usuario el 29/10/2026;
no se presentan como comentarios públicos ni como evidencia de ejecución.

Fuentes normativas contrastadas: Docs master
`599c34f4e677c8792532e2cc31ac372473a10710`, OpenAPI 0.6.0-rc.1
(`CorrelationId`, UUID extremo a extremo), AsyncAPI 0.6.0-rc.3,
DEC-F-001/006/009/011/012, SPEC-003/004/009/010, acuerdo Pricing/Catalog,
paquete G1 H4 y guías Oracle. La política #144 no habilita esta mensajería ni
concede grants. No se cambia autenticación ni selección de modos demo.

## Corrección implementada — IMPLEMENTAR_AHORA (#49)

El preview usa `PricingClient` y el GET administrativo existente
`/api/v1/precios/productos/{productoId}` con respuesta global `channel_id=null`.
No es la consulta comercial por SKU/canal. Vera confirmó que no había trazas
correlacionadas entre ese cliente y Pricing. El cliente no enviaba el header y
las dos etapas SQL tampoco recibían el ID que ya tenía el servicio HTTP.

- Listado y detalle preview transmiten el mismo `X-Correlation-Id` a Pricing.
  No se propaga Authorization ni una identidad entrante. Se conservan endpoint,
  timeout, cuatro workers, llamadas por candidato, descartes, total y paginación.
- `DEMO_CANDIDATES_SQL`, `DEMO_ENRICHMENT_SQL`, `DEMO_PRICING` y
  `DEMO_LIST_TOTAL` reciben el UUID de la misma petición. No se cambian las
  consultas ni los presupuestos de SELECT de los listados optimizados.
- El cliente valida el UUID opcional antes de enviar. Para invocaciones sin
  contexto, como readiness independiente, genera un UUID técnico mediante el
  helper existente. No convierte un token o dato libre en correlación.
- Las pruebas no atribuyen latencia de la fixture HTTP a Pricing real ni
  homologación a un mock. Esta corrección habilita correlación desde Catalog;
  no garantiza que Pricing registre el header en su versión desplegada.

Prueba de regresión previa: cuatro fallos / 22 PASS. Después, 26 pruebas de
cliente/equivalencia PASS y cinco casos HTTP locales PASS: listado antes de
paginar, detalle 200/404/503 y solicitudes simultáneas con UUID separados.
La prueba HTTP usa Catalog real con repositorio de fixture y Pricing como
servidor HTTP de fixture; no ejecuta su implementación ni PostgreSQL.
Las validaciones generales y CI se registran en el PR con su SHA exacto.

Validación local final: 435 unitarias PASS; 150 E2E PASS / 48 SKIP; typecheck,
lint, format:check, build:catalog-svc, tipos estrictos de los tests afectados
y diff --check PASS. Docker no está disponible localmente: SKIP no equivale
a integración PostgreSQL/RabbitMQ. Se ajustó la expectativa de una llamada
mock al argumento opcional de correlación y se explicitó el tipo de la
fixture parcial del repositorio para verificar sus pruebas con TypeScript.

## Decisiones y evidencia pendientes por persona

| Owner | Información confirmada | Operación / estado | Condición verificable de desbloqueo |
|---|---|---|---|
| Marco / infraestructura | No realizó nueva verificación integral ni despliegue posterior al corte Oracle | Validación remota #47–#49: BLOQUEADO_ESPECÍFICO por evidencia actual ausente | Captura autorizada de solo lectura, imágenes/SHA/digests, readiness y operaciones de los servicios efectivamente ejecutados |
| Marco + owners AMQP | A/B/C evaluadas; A candidata, recuperación con DLQ saturada falló; ninguna alternativa adoptada | Runtime AMQP: BLOQUEADO_ESPECÍFICO; conservar gate cerrado | Decisión publicada/versionada, prueba de recuperación satisfactoria, recursos/ACL/red autorizados y pruebas positivas/negativas |
| Marco / Bulk + Poma | Propuesta V2 aún local; comandos por sku_base, batch_id/operation_id/row_id, resultado por fila, límite propuesto 1 MiB | catalog.bulk.upsert.*: BLOQUEADO_ESPECÍFICO de contrato tipado | Publicar propuesta revisable, cerrar atomicidad/fingerprint/errores/reanudación con Catalog, aprobar y tipar los tres payloads en Docs y probar ambos lados; no adoptar campos/límite solo por este resumen |
| López + Marco | taxonomy.product-type-schema.changed y taxonomy.characteristic-value.updated tienen semántica SPEC, pero AsyncAPI todavía usa GenericData | Proyecciones específicas: BLOQUEADO_ESPECÍFICO de definición wire | Publicar payloads tipados/versionados, campos obligatorios y orden/versionado convergente; productor identificado y prueba de efectos antes del handler Catalog |
| López + Gateway/BFF | taxonomy.category.updated es stable, con consumidores adicionales y sin payload enumerado en SPEC | Proyección de categorías: BLOQUEADO_ESPECÍFICO | Definir payload/versión y compatibilidad/homologación de los consumidores afectados; no inventar shape ni modificar stable unilateralmente |
| Vera + Poma | Pricing comercial tiene PRICING_CATALOG_CONTEXT=null en el runtime consultado; falta adaptador real | Consulta comercial SKU/canal: IMPLEMENTAR_PARCIAL; Catalog conserva cliente/contexto ya implementados | Vera conecta su adaptador real por HTTP contractual; grant G7 y prueba bilateral con versiones y trazas; no cambiar Pricing desde Catalog |
| Taco + Poma + Marco | Inventory tiene pruebas propias de completed/rejected/replay con PostgreSQL y RabbitMQ aislados | Preparación bilateral: IMPLEMENTAR_PARCIAL; no equivale a ambos runtimes integrados | Harness de #113/#115 o entorno autorizado; ejecución Catalog/Inventory con IDs causales, persistencia y resultados reales de ambos lados |
| G7 | No hay nueva evidencia de concesión en las respuestas recibidas | Integración autenticada: BLOQUEADO_ESPECÍFICO | Grant/credenciales efectivos y prueba positiva/negativa del cliente/usuario aplicable; no publicar secretos |

Para los tres eventos Taxonomy de proyección, `operation_id` es anulable en
el envelope vigente. La propuesta de diseño requiere dedupe técnico por
`message_id` y convergencia por entidad; no usar operation_id como clave
obligatoria. No se implementa una proyección sin su contrato. Esto no cambia
la exigencia de operation_id UUID del protocolo tipado de bajas seguras ni de
los resultados de preparación ya implementados. `CLEAR | IN_USE` sigue vigente.

López propone incluir el tipado en el cambio contractual asociado a #45;
esa propuesta no se considera ya fusionada ni homologada. Los handlers
GenericData siguen explícitamente bloqueados y no fabrican resultados Bulk.

## Aclaraciones sobre Inventory y Oracle

La suite aportada por Taco se encuentra en
`apps/inventory-svc/test/inventory.real.integration.spec.ts`, caso
«consume, confirma duplicados y rechazos durables sin duplicar saldo ni
operación». Se inspeccionó solo lectura: prueba INITIALIZED, rechazo
UBICACION_NO_ENCONTRADA, Inbox y replay con misma operación/nueva entrega.
Su evidencia pertenece a Inventory; no prueba el consumidor Catalog ni el
flujo bilateral. Run aportado: `40377759886`; el resultado exacto vigente del
presente cambio se obtiene de su propia CI, no de ese run histórico.

La afirmación comunicada de que Catalog figura «No desplegado» no coincide
con `ops/oracle/ESTADO_SERVICIOS.md`: el corte 20/10 registra Catalog con
imagen `9205eb4`, e Inventory como no desplegado. No hay contradicción sobre
la falta de un entorno bilateral validado. Marco confirma que no existe un
corte integral posterior; se conserva la auditoría histórica y no se afirma
cuál es la imagen ejecutándose hoy sin nueva captura. No se editan informes
históricos ni se atribuye autorización de release a un merge de Inventory.

## Paquete de evidencia que falta para #49

Preparación documental para Marco/operador, sin ejecución remota en esta tarea:

1. Registrar ventana UTC, servicio, revisión inmutable, image ID y digest real
   de Gateway, Catalog y Pricing mediante acceso autorizado de solo lectura.
   Mantener las tres revisiones separadas; no necesitan el mismo SHA de código.
2. Registrar `/health` y readiness efectivos de cada imagen, incluyendo fallos.
   No confundir liveness, readiness y operación comercial.
3. Ejecutar las lecturas autorizadas con dataset/filtros/orden/página/tamaño
   identificados y un UUID por petición. Guardar status, total/items y tiempos
   externos; preservar el UUID en las llamadas internas. Identificar si el
   caso usa preview administrativo por producto o consulta comercial por SKU.
4. Exportar únicamente campos técnicos sanitizados de las tres capas:
   timestamp, correlation_id/correlationId, servicio/etapa, éxito, status y
   duración. No exportar env, tokens, cuerpos, URLs con secretos ni logs crudos.
   Ausencia de una etapa/header registrado se anota como brecha de evidencia.
5. Relacionar los cuatro tiempos Catalog con los del upstream y el Gateway;
   una suma de duraciones concurrentes no es latencia total. Conservar errores,
   calentamiento y condiciones comparables; no inferir p95 de unas pocas sondas.
   Evaluar los 7 s únicamente sobre el candidato efectivamente ejecutado.

Estado del bloque: PARTIAL. #47 conserva implementación interna y evidencia
de #50; #48 mantiene aisladas sus fronteras pendientes; #49 corrige aquí su
propagación de correlación. Los N+1 de detalle/adminVariants/demoPrices siguen
identificados para priorización H4, sin ampliación en esta revisión.
No se hizo merge del PR, despliegue, acceso operativo, DML compartido ni cambio
de contratos/infraestructura/otras aplicaciones.
