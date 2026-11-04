# Ficha — bulk-svc

## A. Identidad

Owner Castilla; rama `castilla`, HEAD `f418cf335007bed9397d5d5d30c36183fe47517c` (docs-only respecto al SHA de código `83240f239ba98678ce217e1678970af77ad3a73d`). Puerto 3008 / `BULK_SVC_PORT`. Schema físico `bulk` existe; scaffold no configura DB/Rabbit. Proyecto/contenedor `g6-bulk-svc`, Compose genérico, runtime `/etc/g6-bulk-svc/runtime.env`, estado `/var/lib/g6-productos-ofertas/bulk-svc`. No desplegado al corte 19-oct; `apps/bulk-svc/` solo demuestra scaffold health.

## B. Configuración runtime

Compose inyecta `NODE_ENV=production`, `PORT=3008`, `BULK_SVC_PORT=3008`. Consumidor bootstrap de puerto `apps/bulk-svc/src/main.ts`; cualquier database, storage, queue o secret var debe venir de un Issue y parser real (no existe evidencia para enumerarlas). Env file `/etc/g6-bulk-svc/runtime.env` está en registry, no significa que haya variables ya definidas.

## C. Dependencias

Publicación loopback, `g6-http` opt-in. Sin dependencia DB, storage, Rabbit o microservicio implementada/demostrada en scaffold. Expresar dependencias del contrato una vez verificadas.

## D. HTTP / seguridad

OpenAPI rc.1 tag Carga masiva gobierna endpoints. Scaffold actual no demuestra implementación negocio; upload/export, tamaño, idempotencia y scopes deben seguir exactamente contrato/decisiones. `/health` liveness; readiness negocio pendiente. No activar ruta Gateway hasta funcional.

## E. RabbitMQ

La VM contiene `po.masivos.q`, user `g6_masivos` con permiso write `po.comandos.x` y read queue, pero no hay producer/consumer del scaffold probado. No deducir uso solo por el nombre del servicio; ver AsyncAPI y compatibilidad. Retry/DLX no aprobado.

## F. Persistencia

Sin tabla/schema/migración implementada confirmada. Si el issue requiere staging/import, definir en contrato y decisión aplicable antes de persistir; no DDL al bootstrap.

## G. Pruebas y aceptación

`npm run build:bulk-svc`; `npm test -- apps/bulk-svc`; `npm run test:e2e -- apps/bulk-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh bulk-svc`; generic image/Compose. CI generic health smoke solo; prueba de carga/archivo/AMQP/DB no consta y se añadirá como implementación del scope aprobado, nunca para Oracle destructivo.

## H. Bloqueos y entrega

Castilla: verificar paridad con OpenAPI para import/export, límites/seguridad, idempotencia y dependencias; desarrollar integración aislada. Marco: definir runtime/infra solo después de que el owner demuestre necesidades, luego release individual. `/health` 200 no acredita carga masiva.
