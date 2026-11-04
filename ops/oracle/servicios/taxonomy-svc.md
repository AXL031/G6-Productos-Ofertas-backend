# Ficha — taxonomy-svc

## A. Identidad

Owner Lopez; HEAD `origin/lopez` contrastado `4e099f5c04d7ba17a100b669c6a85f4eae6f90ec`. Puerto 3006 / `TAXONOMY_SVC_PORT`; schema `taxonomy`. Proyecto/contenedor `g6-taxonomy-svc`, Compose genérico, runtime `/etc/g6-taxonomy-svc/runtime.env`, estado `/var/lib/g6-productos-ofertas/taxonomy-svc`. Oracle 19-oct: desplegado; readiness 200 y categorías vía Gateway 200.

## B. Configuración runtime

| Variable | Requisito | Bootstrap |
|---|---|---|
| `NODE_ENV`,`PORT`,`TAXONOMY_SVC_PORT` | Compose production/3006 | Dockerfile genérico también define production; Compose fija ambas variables de puerto |
| `DATABASE_URL` | requerida; URI PostgreSQL con host, puerto, base y credenciales | runtime.env; contraseña secreta; SSL `verify-full`, CA y `currentSchema=taxonomy` como parámetros |
| `G6_EXPECTED_ROLE` | requerida: `taxonomy_dev_login` o `taxonomy_app` | runtime.env; identidad validada por provider |
| `G6_CONNECTION_MODE` | requerida: `session` o `direct` | runtime.env; provider aplica modo |
| `G6_CONNECT_HOST` | opcional; host TCP alternativo manteniendo TLS contra el host nominal | runtime.env |
| `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD`,`PGSSLMODE`,`PGSSLROOTCERT`,`G6_DATABASE_SCHEMA` | se derivan/validan desde `DATABASE_URL` por parser/provider; schema debe ser taxonomy | No configurar aliases separados sin confirmar precedencia | `database.ts` valida conexión efectiva y verify-full |

Dockerfile genérico fija `NODE_ENV=production` y `TAXONOMY_SVC_HOST=0.0.0.0`; Compose fija `NODE_ENV`, `PORT` y `TAXONOMY_SVC_PORT` y monta CA read-only. `DATABASE_URL`, `G6_EXPECTED_ROLE`, `G6_CONNECTION_MODE` y cualquier `G6_CONNECT_HOST` proceden de runtime.env.

## C. Dependencias

PostgreSQL schema taxonomy, readiness ejecuta consultas de lectura categories/brands. `g6-http` alias `taxonomy-svc`; Catalog depende de Taxonomy por HTTP privado. Oracle GET categorías y readiness sí observados; no probaron otros upstreams. Sin conexión AMQP probada desde VM.

## D. HTTP / seguridad

OpenAPI docs origin/master SHA `c36bd9a...`, rc.1 tag Taxonomía. Código actual `taxonomy.controller.ts` incluye `GET /api/v1/categorias` y `GET /api/v1/marcas`; revisar rutas extra contra OpenAPI. `/health/readiness` y `/health/ready` ambos 200 observados; `GET /api/v1/categorias` 200 vía Gateway, la única ruta de negocio probada externamente al alcance auditado. JWT/scopes según contrato; no deducir permiso público.

## E. RabbitMQ

Infra física user `g6_taxonomia` permite write sobre exchanges base y read `po.taxonomia.q`, pero app runtime AMQP no acreditada por evidencia actual. AsyncAPI gobierna eventos; no habilitar publisher hasta comparar nombres y conectar red aprobada. No retry/DLX.

## F. Persistencia

Schema `taxonomy`; readiness de lectura observada a PostgreSQL. Rol/migraciones y permisos se deben contrastar con DDL del SHA; consultas de read master data; no DDL al bootstrap. Tests DB real aislados desde script CI taxonomy integration.

## G. Pruebas y aceptación

`npm run build:taxonomy-svc`; `npm test -- apps/taxonomy-svc`; `npm run test:e2e -- apps/taxonomy-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh taxonomy-svc`; Docker generic Compose; `node scripts/ci/run-taxonomy-integration.mjs` para PostgreSQL desechable; readiness + categorías/marcas por Gateway con auth apropiada. CI ejecuta integración Taxonomy dedicada, no todos los HTTP flows.

## H. Bloqueos y entrega

Lopez: mantener evidencia de DB/readiness por SHA y ampliar funcional smoke contractual. Marco: confirmar estado runtime y autorización si hay nuevo SHA; Gateway necesita arreglar dependencia Catalog antes readiness completa. Operatividad de categorías no implica producto completo.

## Marketplace H4 — Taxonomy

G1 consume categorías vía `listarCategorias` (`GET /api/v1/categorias`); la consulta de marcas comerciales corresponde a la operación publicada en OpenAPI (`listarMarcas`, GET `/api/v1/marcas`). Mantener solo datos comerciales elegibles; no exponer DTO administrativo. La evidencia Provider, scope y estado por SHA se actualizan en la [matriz H4](../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md).
