# Ficha — inventory-svc

## A. Identidad

Owner Taco; HEAD contrastado `origin/taco` `b02615841f63ea3249d9ad16a0cf32f4ea2b20c2`, pendiente. Puerto 3005 / `INVENTORY_SVC_PORT`; schema físico `inventory` (ver [esquemas](../SUPABASE_ESQUEMAS.md)); configuración candidata DB debe verificarse contra provider antes de runtime. Proyecto `g6-inventory`, Compose `docker-compose.inventory.yml`, contenedor `g6-inventory-svc`; runtime `/etc/g6-inventory/runtime.env`; estado `/var/lib/g6-inventory`. No desplegado al corte Oracle 19-oct.

## B. Configuración runtime

| Variable | Requisito / secreto | Código de rama / bootstrap |
|---|---|---|
| `PORT`,`INVENTORY_SVC_PORT` | puerto Compose 3005; no secreto | `src/config/inventory.config.ts`, integer 1–65535 |
| `DATABASE_URL` | opcional para arranque; alternativa completa a `PGHOST`,`PGDATABASE`,`PGUSER`,`PGPASSWORD`; contiene credenciales | runtime.env; URL contiene credenciales | `database.service.ts` crea pool con URL y valida `SELECT 1`; si falta la configuración, el servicio inicia sin pool y DB readiness falla |
| `PGHOST`,`PGDATABASE`,`PGUSER`,`PGPASSWORD` | alternativa completa a `DATABASE_URL`; obligatorias en conjunto para pool por campos; contraseña secreta | runtime.env, no copiar valores | `database.service.ts`; configuración parcial no crea pool |
| `PGPORT` | opcional; default 5432; si se expresa debe ser entero 1–65535 | Compose no lo inyecta; runtime.env si cambia | `inventory.config.ts` |
| `PGSSLMODE` | opcional; `disable` desactiva TLS; valor ausente no desactiva TLS para host/URL remotos | runtime.env | `database.service.ts`; no equivale a `sslmode` PostgreSQL para todos los modos |
| `PGSSLROOTCERT` | opcional; si la ruta existe, usa su CA y `rejectUnauthorized=true`; si no existe, el cliente cae a TLS con validación predeterminada para conexión remota | runtime.env; ruta montada por Compose en producción | `database.service.ts`; debe verificarse contra el certificado/runtime provisionado |
| `RABBITMQ_URL` | opcional para bootstrap; requerida para flujo AMQP | runtime.env; secreto | config candidata; conexión al broker no verificada ni autorizada |
| `RESERVATION_TTL_SECONDS` | default 900, >=1 | integer validated |
| `DEFAULT_LOW_STOCK_THRESHOLD` | default 5, >=0 | integer validated |
| `INVENTORY_WORKER_INTERVAL_MS` | default 5000, rango 250..2147483647 | integer validated |
| `INVENTORY_WORKER_BATCH_SIZE` | default 50, 1..500 | integer validated |
| `INVENTORY_DEMO_NO_AUTH_ENABLED` | default false; excepción puntual solo dos operaciones | `loadCommercialDemoConfig`; boolean |
| `INVENTORY_DEMO_GATEWAY_IPS` | requerido si demo true, IPs literales | config canonicaliza IP, rechaza inválidas |
| `G7_JWT_ISSUER` | obligatoria para endpoints protegidos | runtime.env; valor coordinado con Seguridad G7 | `auth.constants.ts`; token debe validar `iss` |
| `G7_JWT_PUBLIC_KEY` | obligatoria para endpoints protegidos; PEM público RS256 | runtime.env; material público provisto por Seguridad | `inventory-auth.guard.ts`; sin clave confiable se rechaza el token |
| `JWT_PUBLIC_KEY` | alias heredado opcional, usado solo si falta `G7_JWT_PUBLIC_KEY` | runtime.env si se usa; PEM público | fallback explícito del guard; no sustituye el issuer |

Dockerfile propio fija `NODE_ENV=production`, `EXPOSE 3005` y ejecuta directamente `CMD ["node", "dist/apps/inventory-svc/main.js"]`; no copia ni necesita `dist/apps/g6-service-entrypoint.mjs`, que pertenece al mecanismo de `Dockerfile.service`. Compose de producción inyecta `NODE_ENV`, `PORT=3005`, `INVENTORY_SVC_PORT=3005` y monta la CA de solo lectura en el overlay HTTP. Los valores de negocio/DB/demo deben venir de `/etc/g6-inventory/runtime.env`.

## C. Dependencias

PostgreSQL TLS y Rabbit candidate; su Compose puede unirse `g6-http` vía overlay opt-in, no `g6-edge`. Rabbit sigue aislado. No localhost para containers. Outbox/Inbox candidate exige DB y broker reales en tests.

## D. HTTP / seguridad

OpenAPI oficial rc.1 lista availability, reservation, consume/release, thresholds/dashboard; branch personal implementa endpoints deben mapearse al contrato exacto. `/health` liveness; readiness real de DB/broker pendiente confirmar. Demo no-auth está restringido en config a `consultarDisponibilidadComercial` y `verificarCantidadComercial` desde IPs Gateway exactas; no quitar JWT en rutas generales. No hay despliegue al corte.

## E. RabbitMQ

Branch `taco` consume `po.inventory.q`; el outbox elige `po.events.x` o `po.results.x` y usa `row.event_type` como routing key. La topología observada es `po.inventario.q`, `po.eventos.x` y `po.resultados.x`: incompatibilidad bloquea el deploy AMQP. Ver matriz común.

## F. Persistencia

DB schema/tabla/transacciones de reservas, stock, outbox/inbox deben verificarse desde migrations exactas de SHA. Nunca ejecutar DDL al bootstrap. Probar idempotencia/atomicidad y SQL real aislado.

## G. Pruebas y aceptación

`npm run build:inventory-svc`; `npm test -- apps/inventory-svc`; `npm run test:e2e -- apps/inventory-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh inventory-svc`; `docker-compose.inventory.yml` + HTTP overlay; PostgreSQL/Rabbit aislados para reservation/outbox/readiness. CI build Dockerfile inventory y `/health` solamente; no acredita DB readiness ni AMQP.

## H. Bloqueos y entrega

Taco: entregar compatibilidad exacta de topología, TLS readiness, permiso mínimo, outbox/inbox con pruebas reproducibles y ruta funcional no destructiva. Marco: red Rabbit aislada autorizada y deployment approval individual. No usar smoke que cambie stock en Oracle.

## Marketplace H4 — Inventory

G1 consume `consultarDisponibilidadComercial` (`GET /api/v1/inventario/disponibilidad/comercial`) y `verificarCantidadComercial` (`POST /api/v1/inventario/disponibilidad/comercial/verificar`). D-INV-01 exige una única fuente ejecutable. Cuatro estados comerciales, `INDETERMINADO` incluido, no son errores técnicos; verificación `binding=false` no reserva. Fulfillment ambiguo no se resuelve sumando ubicaciones. Scope, HTTP/Provider, CI de HEAD, despliegue y autorización se mantienen separados en la [matriz H4](../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md).
