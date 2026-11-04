# Ficha — promotions-svc

## A. Identidad

Owner Cueva; HEAD contrastado `origin/cueva` `3f42e0e474071a13eb1b3120819d142cfeda4a95`, pendiente. Puerto 3004 / `PROMOTIONS_SVC_PORT`; schema candidato `promotions`. Proyecto/contenedor `g6-promotions-svc`; Compose genérico; runtime `/etc/g6-promotions-svc/runtime.env`; estado `/var/lib/g6-productos-ofertas/promotions-svc`. No desplegado al corte Oracle 19-oct.

## B. Configuración runtime

| Variable | Estado / uso | Fuente / validación |
|---|---|---|
| `NODE_ENV` | `development` por defecto, debe ser `production` para release | Compose define production; Dockerfile genérico define production | Compose sobrescribe la imagen |
| `PROMOTIONS_SVC_PORT`,`PORT` | precedence específica; default 3004, entero 1–65535 | Compose fija ambas a 3004 | parser de servicio |
| `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD` | todas obligatorias; `PGPASSWORD` secreto | `/etc/g6-promotions-svc/runtime.env` | config exige valores utilizables |
| `PGSSLMODE`,`PGSSLROOTCERT` | obligatorias; modo literal `verify-full`, CA absoluta legible X.509 | runtime.env + CA montada | no hay downgrade TLS |
| `G6_DATABASE_SCHEMA`,`G6_CONNECTION_MODE` | obligatorias: `promotions` y `session` | runtime.env | no omitir ni sustituir por `DATABASE_URL` |
| `RABBITMQ_URL` | obligatoria aunque probes y coupon runtime estén apagados; amqp/amqps sin query/fragment | runtime.env; sensible | configuración obligatoria, pero conectividad Oracle no verificada |
| `PROMOTIONS_DEPENDENCY_PROBES_ENABLED` | opcional, default `false`, solo `true`/`false`; true habilita comprobaciones reales bajo demanda | runtime.env | probes no crean topology/consumer |
| `PROMOTIONS_COUPON_RUNTIME_ENABLED` | opcional, default `false`, solo boolean; true requiere adaptadores/condiciones de #33 | runtime.env | flag no reemplaza configuración obligatoria |

Dockerfile genérico define `NODE_ENV=production`, host bind 0.0.0.0 y `/health` de contenedor. Compose inyecta NODE_ENV/PORT/puerto específico y monta CA read-only. Todas las variables de aplicación requeridas y flags opcionales proceden de runtime.env; no consta runtime Promotions desplegado.

## C. Dependencias

PostgreSQL candidate schema promotions; Rabbit events candidate, red isolated; `g6-http` pendiente al no estar desplegado; ningún upstream HTTP probado.

## D. HTTP / seguridad

OpenAPI official rc.1 define promociones/cupones/recomendaciones. Current branch business controllers deben compararse operation por operation al merge; scaffold master no demuestra implementación completa. `/health` liveness; readiness dependencias real pendiente. Requiere JWT/scopes contractuales; no activar demo no-auth en producción.

## E. RabbitMQ

Branch Cueva consume `po.promotions.q`, publica comandos candidate en `po.commands.x` con routing keys `promotions.coupon.consumption.requested` y `promotions.coupon.restoration.requested`, y resultados en `po.results.x`. La topología física usa `po.promociones.q`, `po.comandos.x`, `po.resultados.x`; ACL observada del usuario de servicio no permite publicar en el exchange inglés. Bloqueo de deploy AMQP; consultar [matriz](../RABBITMQ_COMPATIBILIDAD.md).

## F. Persistencia

Branch candidate declara schema `promotions`; lista tablas/DDL/rol exacto por verificar del commit antes de release, no aplicar migraciones al arranque. Necesita pruebas PostgreSQL desechables y decisiones de reglas contractuales.

## G. Pruebas y aceptación

`npm run build:promotions-svc`; `npm test -- apps/promotions-svc`; `npm run test:e2e -- apps/promotions-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh promotions-svc`; Docker generic Compose; pruebas DB/Rabbit aisladas cuando existan. No hay smoke Oracle; sin producción AMQP.

## H. Bloqueos y entrega

Cueva: demostrar paridad OpenAPI/AsyncAPI y readiness real; resolver exchange/queue/keys/retry con owner de contrato; evidencia DB/TLS/AMQP y permisos mínimos. Marco: mecanismo red broker, credenciales y release con autorización propia.

## Marketplace H4 — Promotions

Las capacidades de canal son `listarPromociones`, `evaluarPromociones`, `validarCupon` y `obtenerRecomendaciones` según OpenAPI. Evaluación y validación no consumen beneficios; G5 orquesta consumo/restauración. Consumidores AMQP/Outbox no acreditan handler HTTP ni runtime de esos operationIds. No atribuir precio/availability a recomendaciones sin schema/decisión. Ver [matriz H4](../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md) para evidencia ligada a PR/SHA.
