# Ficha — taxonomy-svc

## A. Identidad

Owner Lopez. `4e099f5c04d7ba17a100b669c6a85f4eae6f90ec` es la revisión histórica consignada en la ficha anterior. La revisión `f1d35ed26cdacf3e93687d6acab1c04e8cdb4d03` se integró en PR #131 (merge `a74b9547263e426eeeed2b5b2c69cb3faa5e4670`); ampliaciones posteriores de entidades/reglas se integraron, entre otras, en PR #178 (merge `606e36ce668b46b01a8681ea6028d93e0b02f7e5`). Código de referencia actual: Backend `master` `921fcfa443499f0af9dc63360f664da7f4001d5d`. La auditoría Oracle del 19-oct observó la imagen `97ca576282e93e8b35f4bc33b5cbcb972e63caef`, distinta del código actual de `master`; esa observación no establece qué imagen está activa hoy. En ese corte se observó readiness 200 y categorías vía Gateway 200. Código integrado e imagen/despliegue son estados independientes.

## Política de seguridad progresiva H4

Taxonomy se prepara junto con Catalog como primer candidato de revisión, sin autorización de exposición o despliegue. Ver [política operativa](../H4-MODO-DEMO-AUTH-REVERSIBLE.md). `G6_SECURITY_MODE` no está implementado. `ALLOW_DEMO_UNAUTHENTICATED` solo permite demo en desarrollo/test; no habilita lectura pública Oracle. La respuesta anónima de categorías indicada abajo es evidencia histórica del corte auditado, no aprobación vigente. Publicación requiere aprobación exacta, evidencia de no mutación/sensibilidad y pruebas ligadas al SHA.

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

PostgreSQL schema taxonomy, readiness ejecuta consultas de lectura categories/brands. `g6-http` alias `taxonomy-svc`; Catalog depende de Taxonomy por HTTP privado. GET de categorías y readiness se observaron en Oracle en el corte 19-oct; no probaron otros upstreams ni el runtime de hoy. Sin conexión AMQP probada desde VM en ese corte.

## D. HTTP / seguridad

La revisión normativa Docs `master` consultada al corte de esta actualización es `a7778ec1a22811c1213a94ef096ab905911342cc` (OpenAPI `0.6.0-rc.3`, AsyncAPI `0.6.0-rc.4`); la referencia `c36bd9a...` / rc.1 es histórica. Backend `master` incorpora operaciones HTTP de lectura/escritura y reglas de dominio posteriores a la primera revisión de la ficha (incluidas las líneas de trabajo de PR #131 y #178); cotejar cada `operationId` con OpenAPI y las pruebas del SHA candidato. Las respuestas `/health/readiness`, `/health/ready` y categorías 200 son observaciones de la auditoría del 19-oct, no verificación del runtime actual. JWT/scopes según contrato; no deducir permiso público.

## E. RabbitMQ

Backend `master` contiene implementación de mensajería Taxonomy, incluida la línea de trabajo de outbox/publicación integrada en PR #173 y cambios posteriores de PR #178. Esto prueba presencia de código, no conexión u operación del broker en Oracle. La evidencia física de 19-oct no demuestra una conexión runtime; AsyncAPI, topología, red, identidad y permisos deben verificarse antes de habilitarla. No inferir retry/DLX ni homologación.

## F. Persistencia

Schema `taxonomy`; readiness de lectura a PostgreSQL observada en el corte 19-oct. Rol/migraciones y permisos se deben contrastar con DDL del SHA; consultas de read master data; no DDL al bootstrap. Tests DB real aislados desde script CI taxonomy integration.

## G. Pruebas y aceptación

`npm run build:taxonomy-svc`; `npm test -- apps/taxonomy-svc`; `npm run test:e2e -- apps/taxonomy-svc`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh taxonomy-svc`; Docker generic Compose; `node scripts/ci/run-taxonomy-integration.mjs` para PostgreSQL desechable; readiness + categorías/marcas por Gateway con auth apropiada. CI ejecuta integración Taxonomy dedicada, no todos los HTTP flows.

## H. Bloqueos y entrega

Lopez: mantener evidencia de DB/readiness por SHA y ampliar funcional smoke contractual. Marco: confirmar estado runtime y autorización si hay nuevo SHA; Gateway necesita arreglar dependencia Catalog antes readiness completa. Operatividad de categorías no implica producto completo.

## Marketplace H4 — Taxonomy

G1 consume categorías vía `listarCategorias` (`GET /api/v1/categorias`); la consulta de marcas comerciales corresponde a la operación publicada en OpenAPI (`listarMarcas`, GET `/api/v1/marcas`). Mantener solo datos comerciales elegibles; no exponer DTO administrativo. La evidencia Provider, scope y estado por SHA se actualizan en la [matriz H4](../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md).
