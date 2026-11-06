# Configuración de `bulk-svc` (#88/#89)

## Variables

| Variable | Uso |
|---|---|
| `NODE_ENV` | Requerida. Solo `development`, `test` o `production`. |
| `BULK_SVC_PORT` | Puerto HTTP; tiene prioridad sobre `PORT`. |
| `PORT` | Puerto alternativo y valor compatible con Compose (`3008`). |
| `BULK_SVC_HOST` | Opcional. Solo admite `127.0.0.1` o `0.0.0.0`. |
| `DATABASE_URL` | Opcional para conservar el smoke de liveness de CI. Si se define, debe ser una URL PostgreSQL válida y segura. |
| `PGSSLMODE` | Opcional si `DATABASE_URL` ya contiene `sslmode`; ambos valores deben coincidir. PostgreSQL remoto exige `verify-full`. |
| `PGSSLROOTCERT` | CA PostgreSQL opcional para conexiones no productivas con confianza configurada y requerida para PostgreSQL remoto en production. Debe ser un archivo PEM legible. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No puede ser `0`. |

El parser no construye una conexión con `PGHOST`/`PGUSER` sueltos. La configuración sin `DATABASE_URL` deja el proceso disponible únicamente para liveness. No se documentan aquí valores privados de `.env.local`.

## Bind y puertos

El puerto por defecto del servicio es `3008`. Se valida como entero decimal entre 1 y 65535, sin espacios ni notación alternativa. El host por defecto es `127.0.0.1` en desarrollo y test y `0.0.0.0` en production dentro del contenedor. Compose mantiene el puerto publicado ligado a loopback.

## PostgreSQL y TLS

Se valida `postgres:` o `postgresql:`, host, usuario y base no vacíos; no se permite fragmento ni parámetros salvo `sslmode` y `sslrootcert`, cada uno una sola vez. Tras validar TLS, esos parámetros se retiran de la URL que recibe `pg`, de modo que no puedan reemplazar las opciones TLS validadas.

PostgreSQL remoto requiere `sslmode=verify-full`, `rejectUnauthorized: true` y comprobación de identidad del servidor. En production se requiere una CA explícita (`PGSSLROOTCERT` o `sslrootcert`). PostgreSQL loopback sin TLS se admite solo en development/test con `sslmode=disable` explícito. No se registran URLs, passwords, certificados ni archivos `.env`.

## Límites operativos locales

Estos límites son política operativa de #88, no límites funcionales de importación:

| Recurso | Límite |
|---|---:|
| HTTP request timeout | 15000 ms |
| HTTP headers timeout | 10000 ms |
| HTTP keep-alive timeout | 5000 ms |
| Solicitudes por socket | 100 |
| Headers HTTP | 100 |
| Pool PostgreSQL | 2 conexiones |
| Timeout de conexión PostgreSQL | 1500 ms |
| Timeout de consulta PostgreSQL | 2000 ms |
| Pool idle timeout | 30000 ms |

## Health y degradación

`GET /health` responde `200` si el proceso HTTP está vivo y no consulta dependencias. `GET /health/readiness` ejecuta `SELECT 1 FROM bulk.batch_jobs LIMIT 0`; devuelve `200` solo cuando el schema/tabla es accesible, y `503` ante URL ausente, conexión fallida, timeout o permisos insuficientes. Las respuestas no incluyen detalles internos. El pool es diferido por `pg` y se cierra durante el apagado de NestJS.

Sin `DATABASE_URL`, se espera `/health` `200` y `/health/readiness` `503`. Esta compatibilidad mantiene el smoke genérico de CI sin declarar el servicio listo. El adaptador Drizzle queda no disponible y no abre otra conexión; el proveedor de persistencia no impide el arranque ni el liveness.

## Persistencia Bulk (#89)

Drizzle usa exclusivamente la misma instancia `pg.Pool` que `BulkReadinessService` recibe por `BULK_READINESS_POOL`. No se crea un pool adicional ni se ejecuta SQL durante el bootstrap. El cierre del pool continúa siendo responsabilidad única de `BulkReadinessService`. Los dobles de readiness no se adaptan a Drizzle: el proveedor solo crea la base Drizzle cuando recibe un `Pool` real.

El schema `bulk` se prepara con el bootstrap y el migrador oficiales de Docs. La aplicación no ejecuta DDL ni modifica `schema_migrations`; los triggers y el resto del DDL permanecen bajo autoridad de la migración oficial. En pruebas, configure únicamente una URL loopback con `sslmode=disable` explícito y una base desechable.

### Prerrequisitos aditivos para exportaciones

Antes de desplegar workers de exportación, aplicar en orden las migraciones Bulk aditivas mediante el proceso revisado de migración del servicio:

1. `migrations/0002_export_source_snapshot.sql` agrega `file_manifests.metadata`, requerida para persistir `requested_at`, los instantes observados y las versiones de las fuentes.
2. `migrations/0003_export_claim_lease.sql` agrega `export_jobs.claim_token` y `lease_until`, requeridas para reclamar, renovar y cercar intentos concurrentes.

Ambas son prerrequisitos de persistencia del flujo exportador. No alterar migraciones históricas, ejecutar DDL desde la aplicación ni aplicar estos cambios directamente en Supabase compartido. Confirmar su aplicación en el esquema destino antes de habilitar los workers.

## Validación local aislada

Use una instancia PostgreSQL desechable, cree/prepare el schema `bulk` y `bulk.batch_jobs` conforme al modelo físico aprobado, y configure una URL de prueba. Para TLS local use un certificado de prueba y una CA PEM aislada; la conexión sin TLS requiere host loopback, `NODE_ENV=development` o `test`, y `sslmode=disable` explícito. No ejecute pruebas de integración de #88 contra Supabase compartido.

## Alcance y compatibilidad

Esta etapa no implementa endpoints comerciales de importación/exportación, parser CSV/XLSX, límite de tamaño contractual, multipart, persistencia de negocio, DDL, migraciones, workers ni AMQP. El Dockerfile y Compose genéricos mantienen el puerto `3008`, `PORT` y `BULK_SVC_PORT`, la comprobación `/health` y el montaje read-only de la CA; el host por defecto en production acepta el contenedor sin cambiar el binding loopback publicado.

## RabbitMQ Bulk (#93)

El transporte está deshabilitado por defecto. Solo `BULK_AMQP_ENABLED=true` junto con `BULK_AMQP_URL` lo activa; la URL no debe registrarse en logs. El runtime utiliza exchanges y la cola existentes, sin declarar ni modificar recursos. El Outbox conserva los mensajes pendientes ante fallo/confirmación ausente o publicación sin ruta. Retry/DLX compartido no está configurado ni aprobado; las pruebas usan RabbitMQ aislado y desechable.

### Recuperación y readiness

Una publicación confirmada pero sin ruta permanece pendiente; el relay la vuelve a comprobar con backoff y no la marca publicada hasta recibir confirmación enrutable. El consumidor conserva ACK posterior a la persistencia Inbox; ante fallo técnico cierra su canal para reencolar la entrega y reconecta con backoff. No se agrega retry/DLX al broker.

`/health/readiness` reporta `DATABASE_NOT_CONFIGURED`, `DATABASE_UNAVAILABLE`, `AMQP_NOT_CONFIGURED`, `AMQP_DISABLED`, `AMQP_TEMPORARY_UNAVAILABLE` o `AMQP_TOPOLOGY_BLOCKED`; devuelve ready con AMQP omitido solo para el peer IP autorizado por `GATEWAY_DEMO_NO_AUTH_ENABLED=true` y `BULK_DEMO_GATEWAY_IPS`. En producción normal, AMQP y ambos workers deben estar listos.

### Discrepancia contractual de reanudación

OpenAPI permite `409 IDEMPOTENCY_CONFLICT` y `503 SERVICIO_NO_DISPONIBLE` para `POST .../reanudar`, pero no define un código para transición no permitida ni para reconciliación sin protocolo homologado. El endpoint no recibe identidad nueva de intento; por tanto, no informa `IDEMPOTENCY_CONFLICT` cuando rechaza un requeue. Mantiene el estado durable y responde `503 SERVICIO_NO_DISPONIBLE` con detalle `BLOQUEADO_ESPECÍFICO` para reconciliación sin protocolo; una transición no elegible también usa 503 por la limitación actual del contrato. El bloqueo contractual se resuelve cuando OpenAPI defina la respuesta para transición no permitida y estado bloqueado. Publicaciones Outbox pendientes se recuperan automáticamente y no requieren requeue.
