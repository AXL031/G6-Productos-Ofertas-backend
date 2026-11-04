# taxonomy-svc

Microservicio de taxonomía (categorías y marcas) del backend G6.

## Consultas HTTP: estado del issue #37

`listarCategorias` y `listarMarcas` consultan registros activos del esquema propio. OpenAPI 0.6.0-rc.2 exige `serviceBearer`, audiencia `api-productos` y scope `catalogo:leer` para ambas operaciones. El guard valida JWT de servicio con firma RS256 mediante discovery y JWKS, emisor, caducidad, audiencia y scope; responde 401 para credenciales inválidas, 403 ante scope insuficiente y 503 cuando Seguridad no está disponible. Configure `SECURITY_ISSUER`, `SECURITY_DISCOVERY_URL` y `SECURITY_JWKS_URL` juntos; sin configuración el acceso autenticado falla cerrado. El registro y grant del scope en Seguridad siguen pendientes. Las pruebas locales de lectura no acreditan autenticación, homologación externa ni despliegue.

El modo demo local es optativo y reversible: `ALLOW_DEMO_UNAUTHENTICATED=true` solo se acepta con `NODE_ENV=test` o `development`, y permite únicamente GET `/api/v1/categorias` y `/api/v1/marcas` sin Authorization desde un par TCP de loopback. Un Authorization presente siempre sigue el guard JWT. No se confía en cabeceras de IP o identidad. Este límite no habilita conexiones entre contenedores ni acredita el aislamiento Gateway/Oracle exigido por la política H4; estas topologías requieren coordinación y evidencia antes de ampliar el acceso.

## Escrituras de categorías y marcas (#38)

Las mutaciones administrativas requieren JWT humano con audiencia `api-productos`; el modo demo no las habilita anónimamente. Las marcas aceptan multipart y conservan la URI explícita si se proporciona; si se envía un archivo sin URI, se guarda `logo_url = NULL`. Taxonomy no conserva el binario ni comprueba la disponibilidad de la URI; almacenar el archivo corresponde a un responsable externo. La validación revisa tamaño y estructura de PNG/JPEG/WebP, e integridad CRC y descompresión de PNG; no decodifica completamente los píxeles JPEG/WebP. En la edición multipart, enviar `descripcion`, `paisOrigenIso` o `logo` como campo vacío borra el valor correspondiente; omitirlo conserva el valor. El registro de una URI no acredita almacenamiento, homologación ni despliegue.

El microservicio valida la estructura de la imagen y persiste la URI/cadena (`logo_url`) o `NULL` en la base de datos. El almacenamiento físico del binario y la infraestructura de CDN permanecen pendientes de definición por la arquitectura/owner externo, sin alterar los contratos OpenAPI vigentes.

## Variables de entorno

El servicio valida la configuración en el arranque y falla cerrado (`fail-closed`): si falta o es inválida alguna variable requerida, no inicia. Nunca imprimir ni registrar valores reales; las credenciales se enmascaran en los logs.

| Nombre | Descripción | Requerido | Valor por defecto |
|---|---|---|---|
| `NODE_ENV` | Entorno de ejecución. Debe ser uno de `development`, `test`, `production`. | Sí | Ninguno |
| `TAXONOMY_SVC_PORT` | Puerto HTTP del servicio. Entero entre 1 y 65535. | Sí (o `PORT`) | Ninguno |
| `PORT` | Puerto HTTP alternativo; se usa solo si no se define `TAXONOMY_SVC_PORT`. | No | Ninguno |
| `DATABASE_URL` | Fuente opcional de parámetros PostgreSQL. Alternativamente se pueden proporcionar `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` y `PGSSLROOTCERT`. Los valores presentes en la URL tienen precedencia. | No, si se proporcionan los parámetros PG | Ninguno |
| `G6_DATABASE_SCHEMA`, `G6_EXPECTED_ROLE`, `G6_CONNECTION_MODE` | Schema `taxonomy`, rol permitido y modo `direct` o `session`. El schema también puede venir en la URL. | Sí | Ninguno |

El pool requiere todos los parámetros PG indicados, `PGSSLMODE=verify-full` y una CA absoluta legible; la URL puede suministrar los valores correspondientes. El arranque valida además la identidad efectiva antes de escuchar.

## Endpoints operativos

- `GET /health`: liveness estático; responde `200` sin consultar dependencias.
- `GET /health/readiness`: readiness; verifica acceso de lectura real con dos consultas Drizzle ORM independientes (sin concatenar SQL), cada una con `WHERE estado = 'ACTIVO' LIMIT 1`:
  - `taxonomy.categories`: selecciona `id`, `nombre`, `categoria_padre_id`, `orden`, `estado`. `orden` se incluye porque la lectura comercial productiva lo usa en `ORDER BY`.
  - `taxonomy.brands`: selecciona `id`, `nombre`, `descripcion`, `pais_origen_iso`, `logo_url`, `estado`.

  Responde `200` solo si ambas consultas resuelven, o `503` (problem+json, `SERVICIO_NO_DISPONIBLE`) ante cualquier error: conexión fallida, permisos denegados (`42501`) sobre las columnas consultadas —incluidas `categories.orden` y `brands.logo_url`—, o tabla/columna ausente.

`GET /health/ready` aplica las mismas comprobaciones. PostgreSQL y AMQP, cuando está configurado, son dependencias de readiness; `/health` es liveness del proceso y no consulta dependencias. La pausa del consumidor AMQP mantiene readiness en `503` hasta reiniciar el runtime.

## Errores y diagnóstico estructurado

Las excepciones inesperadas responden `500 ERROR_INTERNO` con `detail` constante (`Ha ocurrido un error interno en el servicio`). El filtro no incluye el mensaje ni el stack de la excepción. Registra `taxonomy.http.unexpected_error` con servicio, código, estado, categoría fija y `correlation_id` solo cuando es UUID válido. Las excepciones `ProblemDetailsException` y HTTP controladas mantienen su respuesta contractual.

Las señales de baja cardinalidad incluyen `taxonomy.database.query_failed`, `taxonomy.database.idle_connection_failed`, `taxonomy.health.readiness_failed` (componente `postgres` o `amqp`), `taxonomy.amqp.consumer_paused` (tres intentos, entrega sin ACK), `taxonomy.amqp.outbox_publish_pending` y `taxonomy.deactivation.recovery_failed`; las discrepancias de bajas vencidas se informan con `taxonomy.deactivation.recovery_discrepancy`. Los eventos no incluyen mensajes de excepción, credenciales ni payloads. Estas señales están instrumentadas en código; la configuración de alertas y dashboards externos queda a cargo de Operaciones.

## Persistencia

Las operaciones HTTP de Taxonomy se comprueban contra el OpenAPI oficial, el Gateway, los controladores Nest y sus pruebas mediante `node scripts/ci/check-taxonomy-contract.mjs ../docs/contratos/http/openapi.yaml`. La documentación del contrato y las pruebas locales no acreditan grants externos, homologación con Catálogo ni despliegue.

El límite de valores LISTA se configura mediante `MAX_ACTIVE_LIST_VALUES`; la migración aditiva `0005_configurable_list_values.sql` instala el valor inicial y actualiza el trigger para aplicar el mismo límite. Su aplicación a cualquier base compartida requiere el procedimiento autorizado.

- Driver `drizzle-orm` sobre `pg` (`node-postgres`).
- Esquema en `src/persistence/taxonomy.schema.ts`: `taxonomy.categories` y `taxonomy.brands` mapeadas al modelo físico, incluido el enum `taxonomy.estado_entidad` y la columna generada `nombre_normalizado`.
- `DrizzleTaxonomyRepository` implementa `TaxonomyRepository` y `TaxonomyReadinessIndicator`; las lecturas filtran por `estado = 'ACTIVO'`.
- Con `DATABASE_URL` definida el módulo usa el repositorio Drizzle; sin ella usa `UnconfiguredTaxonomyRepository` (responde `503`). Los fallos de conexión se traducen a `503 SERVICIO_NO_DISPONIBLE`; el resto se propaga y el filtro lo sanitiza como `500 ERROR_INTERNO`.
- Las escrituras se agrupan con `enTransaccion` (commit/rollback) y el pool se cierra al apagar la aplicación (`onApplicationShutdown`).

## Mensajería de desactivación — habilitación controlada

Si se configuran conjuntamente `RABBITMQ_URL` y `TAXONOMY_CATALOG_AMQP_USER`, el runtime usa el vhost `g6-productos-ofertas`, consume `po.taxonomia.q` con ACK manual y publica los tres eventos de baja en los exchanges contractuales. La URL debe incluir usuario y contraseña, y el usuario esperado de Catalog debe ser distinto del usuario de Taxonomy. Una configuración incompleta o inválida falla al arrancar; sin ambas variables el transporte está deshabilitado. No registrar credenciales. Con AMQP habilitado, readiness exige conexión y consumidor activos.

El consumidor valida el envelope y la identidad AMQP, registra Inbox y finaliza en una transacción; los duplicados idénticos no repiten efectos y una colisión de `message_id` pausa el consumo. Un mensaje inválido se registra mediante su huella y causa antes de ACK. El consumidor admite los cinco tipos contractuales. Después de tres fallos locales de persistencia, el consumidor se pausa sin ACK; el cierre devuelve la entrega al broker y no se presupone DLQ. El Outbox solo se marca publicado tras confirmación; si el commit posterior falla, el mismo `message_id` puede publicarse de nuevo. Una confirmación tampoco prueba entrega de negocio: un alternate exchange puede aceptar mensajes sin binding. Se requiere supervisar la cola sin ruta. La ausencia o nulidad de `causation_id` se admite conforme al AsyncAPI; en ese caso se exige una solicitud Outbox de la misma operación y correlación, además de validar entidad y versión. Si el campo viene informado debe corresponder al `message_id` de la solicitud; la coordinación con Catalog sigue pendiente.

El relay recorre pendientes mediante un cursor en memoria: un fallo conserva la fila, incrementa `attempts` y registra `BROKER_PUBLISH_UNCONFIRMED`, pero permite avanzar a otras operaciones. Los eventos de la misma operación esperan a sus predecesores pendientes para preservar el orden causal. Al terminar el recorrido, el cursor vuelve al principio para reintentar; el reinicio también lo reinicia. Alertar por intentos persistentes y resolver la causa mediante intervención autorizada; no se descarta ningún mensaje ni se supone una DLQ.

El relay también publica `taxonomy.category.updated`, `taxonomy.product-type-schema.changed` y `taxonomy.characteristic-value.updated` desde el Outbox en `po.eventos.x`. Las pruebas aisladas no acreditan bindings, ACL ni conectividad del broker compartido. La baja de asociaciones requiere la migración aditiva `0004_product_type_pending_version.sql`; su aplicación a infraestructura compartida queda sujeta al proceso autorizado.

La conexión al broker compartido no está acreditada: Marco debe verificar red, ACL, bindings y topología; López/Poma deben homologar el flujo y su evidencia. Las pruebas con dobles no acreditan integración real RabbitMQ ni despliegue. No habilitar este transporte en Oracle hasta verificar estas condiciones y los permisos de `taxonomy.inbox`/`taxonomy.outbox` en la instalación autorizada.

## Pruebas de integración (Postgres aislado)

### Observabilidad y reconciliación de bajas vencidas

Al ejecutar `recuperarVencidas()`, las operaciones con entidad ausente, estado distinto o versión no coincidente permanecen `IN_PROGRESS`: no se modifica la entidad, no se emite resultado terminal y no se libera ninguna barrera de Catálogo. El servicio registra el aviso estructurado `taxonomy.deactivation.recovery_discrepancy`, con `operation_id`, tipo y motivo; omite datos de conexión y payloads. Cada instancia inspecciona como máximo una vez cada cinco minutos y registra hasta 50 identificadores. La consulta obtiene como máximo 51 discrepancias con un cursor de UUID que rota entre inspecciones y `muestra_truncada` indica que hay más de 50 en la página; no calcula un total exacto. El cursor es local a cada instancia y se reinicia al reiniciar el proceso. El límite de frecuencia es por instancia y se reinicia al reiniciar el proceso, por lo que la plataforma debe deduplicar entre réplicas. Los casos discrepantes no ocupan los 50 lugares destinados a recuperaciones válidas. Un cambio concurrente durante la restauración se reporta como `CAMBIO_CONCURRENTE`, también con límite de frecuencia por instancia. Si hay pocas o ninguna discrepancia, la inspección aún puede recorrer las operaciones vencidas; medir el plan con datos representativos antes de producción y evaluar un índice mediante el proceso de migración autorizado.

Medición local exploratoria: `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)` sobre PostgreSQL 17 desechable, con 100 000 operaciones sintéticas vencidas y sin discrepancias, devolvió 0 filas en 130,498 ms y mostró un recorrido secuencial de las operaciones. Es una muestra local sin carga concurrente ni datos productivos, no una garantía de latencia; requiere medición con cardinalidad e índices reales antes del despliegue.

El owner de Taxonomy debe investigar la operación y contrastar su versión autoritativa, estado e integración con Catálogo antes de decidir una reconciliación. No debe forzar una versión, liberar barreras ni aplicar SQL a la base compartida sin el proceso autorizado. Una vez corregida y verificada la causa mediante ese proceso, una ejecución posterior puede recuperar la operación; la transacción registra el resultado en outbox. El runner local ejecuta la recuperación cada 10 segundos, evita solapamientos y espera el trabajo en curso al cerrar. Configurar una alerta operativa sobre este evento y monitorear su persistencia también queda pendiente de la plataforma; un aviso local no acredita alerta desplegada ni reconciliación externa.

`scripts/ci/run-taxonomy-integration.mjs` aprovisiona y elimina su propio contenedor `postgres:17-alpine`, publica el puerto solo en loopback y genera la URL/credenciales internamente. Rechaza `TAXONOMY_TEST_DATABASE_URL` recibida desde el entorno. PostgreSQL se inicia con un identificador aleatorio de sesión que el preflight coteja mediante `current_setting()` antes de permitir cualquier DDL; un testigo insertado en una URL recibida no se considera acreditación. No apuntar pruebas destructivas a Supabase ni a bases compartidas.

```sh
node scripts/ci/run-taxonomy-integration.mjs
```

La suite crea esquema, roles y datos de prueba únicamente en el contenedor gestionado por el runner, verifica permisos efectivos (positivos y negativos), transacciones (commit/rollback), readiness y el camino `503`, y elimina contenedor y esquema al finalizar.

## Prueba de solo lectura contra PostgreSQL real

`test/postgres.readonly.e2e-spec.ts` ejecuta el handler HTTP real con el provider PostgreSQL/Drizzle instalado y comprueba, sin escribir, que la proyección de `GET /api/v1/categorias` y `GET /api/v1/marcas` coincide con los conteos de filas `ACTIVO` y solo expone campos contractuales, y que `GET /api/v1/categorias?estado=INACTIVO` responde `400 VALIDACION` con ese provider.

La prueba solo se ejecuta con `G6_READONLY_INTEGRATION=taxonomy` y requiere las variables `PG*`/`G6_*` de `apps/taxonomy-svc/.env.local` (ignorado por git; nunca se commitea) con `PGSSLMODE=verify-full`, el certificado raíz en `PGSSLROOTCERT` y la identidad `taxonomy_dev_login`. Solo hace `SELECT`; no apuntar pruebas destructivas a Supabase ni a bases compartidas.

El archivo `.env.local` se carga con `node --env-file` (Node interpreta correctamente las comillas del archivo) y la corrida debe declarar explícitamente `G6_READONLY_INTEGRATION=taxonomy`, generar el reporte JSON y fijar su ruta de salida. Sin esas tres piezas, vitest omite la suite y no produce evidencia.

PowerShell (Windows):

```powershell
$env:G6_READONLY_INTEGRATION = 'taxonomy'
node --env-file=apps/taxonomy-svc/.env.local ./node_modules/vitest/vitest.mjs run --config ./vitest.config.e2e.ts apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts --reporter=json --outputFile=apps/taxonomy-svc/test/evidence/postgres-readonly-AAAA-MM-DD.json
```

`sh` (Linux/macOS/Git Bash):

```sh
G6_READONLY_INTEGRATION=taxonomy node --env-file=apps/taxonomy-svc/.env.local ./node_modules/vitest/vitest.mjs run --config ./vitest.config.e2e.ts apps/taxonomy-svc/test/postgres.readonly.e2e-spec.ts --reporter=json --outputFile=apps/taxonomy-svc/test/evidence/postgres-readonly-AAAA-MM-DD.json
```

La corrida debe reportar `3 passed` y escribir el JSON. Incluye el arranque real con entorno explícito y comprueba los probes con la conexión disponible y después de cerrar el pool. La trazabilidad de la ejecución (SHA, fecha, versiones y comando) se registra en el sidecar `test/evidence/postgres-readonly-AAAA-MM-DD.md`. Esta prueba no acredita autorización G7, despliegue ni E2E desplegado.

## Verificación de configuración y probes (#34)

Pruebas enfocadas de configuración fail-closed, redacción de secretos y separación liveness/readiness:

```sh
npm test -- apps/taxonomy-svc/src/config/environment.spec.ts apps/taxonomy-svc/src/bootstrap.spec.ts apps/taxonomy-svc/src/logging/sanitized-logger.spec.ts apps/taxonomy-svc/src/database.spec.ts
npm run test:e2e -- apps/taxonomy-svc/test/readiness.e2e-spec.ts apps/taxonomy-svc/test/app.e2e-spec.ts
npm run build:taxonomy-svc
```

El arranque real exige las variables privadas descritas arriba y verifica la identidad PostgreSQL antes de escuchar. Registra la evidencia de cada ejecución local con SHA, fecha, versiones, comandos y resultados; esta no acredita despliegue Oracle, homologación externa ni E2E desplegado.
