# Ficha — api-gateway

## A. Identidad

| Campo | Dato |
|---|---|
| Owner / rama | Transversal; requiere Issue explícito y coordinación (backend `AGENTS.md`). No atribuir owner personal sin Issue. |
| Puerto / env | 3000 / `API_GATEWAY_PORT` (fallback `PORT`) |
| Schema / Docker | Sin DB propia conocida. Proyecto/contendor `g6-api-gateway`, Compose dedicado `docker-compose.gateway.yml`; runtime `/etc/g6-api-gateway/runtime.env`; estado `/var/lib/g6-productos-ofertas/api-gateway`. |
| Oracle (19-oct-2026) | Desplegado; Docker `unhealthy`; `/health` 200; readiness falla por Catalog `not_ready`, cobertura `partial`. `/api/v1/categorias` 200 vía Gateway. |
| Código | HEAD auditado `9205eb455c4965a82ccb9fc4714cf976e4c059b0`; sin rama personal del Gateway. CI exacto verde run `39342273073`. Código `apps/api-gateway/`. |

## B. Configuración runtime

| Variable | Uso / requisito | Suministro / secreto | Consumidor y bootstrap |
|---|---|---|---|
| `NODE_ENV`, `PORT`, `API_GATEWAY_PORT` | Compose inyecta `production`, 3000, `API_GATEWAY_PORT=3000` | Compose; no secreto | `gateway-settings.ts`; puerto entero 1–65535 |
| `GATEWAY_<SERVICE>_URL` | Opcional por upstream definido; origen HTTP(S) sin credenciales | runtime privado / no secreto | `gateway-settings.ts`; solo URL de origen |
| `GATEWAY_<SERVICE>_READINESS_PATH` | Opcional, solo con URL; path confirmado por owner y nunca liveness | runtime privado | valida formato y rechaza `/health` |
| `GATEWAY_TIMEOUT_MS` | opcional; default 5000, rango 1–60000 | runtime privado; no secreto | `gateway-settings.ts` |
| `AUTH_ISSUER`, `AUTH_JWKS_URL` | Opcionales; si `GATEWAY_DEMO_NO_AUTH_ENABLED=false`, deben configurarse ambas o ninguna; cuando se configuran, HTTPS sin user/pass/query/fragment | runtime.env; URL issuer/JWKS, normalmente no secreto | `gateway-settings.ts`; ausencia de ambas es aceptada por parser, no acredita rutas protegidas operativas ni reemplaza el contrato de identidad |
| `GATEWAY_PUBLIC_OPERATION_IDS` | opcional allowlist; solo operationId que OpenAPI marca público | runtime privado | `gateway-settings.ts`; lista inválida falla bootstrap |
| `GATEWAY_DEMO_NO_AUTH_ENABLED` | default false; demo no debe habilitarse en producción | runtime privado; no secreto | `gateway-settings.ts`; excepción de demo explícita |

Compose también conecta `g6-edge` alias `g6-api-gateway` y `g6-http` alias `api-gateway`; publica solo loopback. No imprimir valor runtime.

## C. Dependencias / red

HTTPS: Caddy→Gateway por `g6-edge`. Upstreams HTTP solo por `g6-http` y solo si service autorizado/readiness real. `GATEWAY_*_URL` se obtiene de configuración; gateway espera `/health/ready` por defecto del mapa de código/contrato y paths opcionales explícitos (confirmar exacto en `readiness.js` antes de configurar). No DB propia ni AMQP observados.

## D. HTTP / seguridad

Proxy/rutas autorizadas por `apps/api-gateway/src/routing/contract-routes.ts`, OpenAPI official `0.6.0-rc.1` (docs origin/master SHA `c36bd9a...`) y configuración. No anunciar rutas no incluidas. `/health` es liveness. Compose healthcheck ejecuta `node dist/apps/api-gateway/readiness.js`; auditoría falló al depender de Catalog. La ruta pública GET categorías fue probada; auth negativa 401 en otras rutas no es smoke funcional. JWT/JWKS y scopes del contrato prevalecen; no crear allowlist de operaciones públicas por intuición.

## E. RabbitMQ

No producer/consumer AMQP confirmado en el Gateway. No conectar broker. Ver [compatibilidad](../RABBITMQ_COMPATIBILIDAD.md).

## F. Persistencia

Sin persistencia propia conocida, migraciones o rol PostgreSQL. El Gateway no debe consultar schemas de otros servicios.

## G. Pruebas y aceptación

`npm run build:api-gateway`; `npm test -- apps/api-gateway`; `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh api-gateway`; imagen `Dockerfile.service`; Compose Gateway + overlay HTTP; comprobar `/health`, readiness contra upstreams reales y una operación autorizada vía HTTPS. CI construye imagen y ejecuta readiness bundle, pero no prueba Gateway funcional completo ni token real.

## H. Bloqueos y entrega

Readiness bloqueada por Catalog al corte auditado. Antes de release, issue/owner transversal, cada upstream autorizado+listo, auth/JWKS/scope y routing funcional probados; Marco autoriza deployment individual. Registrar salud parcial y SHA.

### Evidencia complementaria 2026-10-20

El tag Oracle inspeccionado por SSH seguía siendo `api-gateway:9205eb455c4965a82ccb9fc4714cf976e4c059b0`; Docker reportó `healthy`. El bundle de readiness del healthcheck alternó `ready` y `not_ready`, siempre con `coverage=partial`; las rutas de demo públicas dieron 200 (detalles/tiempos en [ESTADO_ACTUAL.md](../ESTADO_ACTUAL.md)). Una solicitud interna a `http://127.0.0.1:3000/health/ready` respondió 404: no declarar que existe ese endpoint HTTP; el healthcheck de imagen invoca un bundle local. El run CI exacto del SHA Gateway es `39038657868`; el run `39342273073` pertenece a `castilla` SHA `83240f2` y no es evidencia CI de este Gateway.

## G1 Marketplace H4 — límite de esta ficha

Operaciones del servicio y estados G1 se mantienen en [`../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md`](../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md). No duplicar schemas: contrastar OpenAPI Docs. El cliente técnico es `modulo-marketplace` desde BFF servidor, audiencia `api-productos`; scopes/grants se verifican por separado. El Gateway solo enruta y aplica políticas: no implementa reglas comerciales. Auth real y deploy no se infieren de rutas declaradas ni de modo demo.
