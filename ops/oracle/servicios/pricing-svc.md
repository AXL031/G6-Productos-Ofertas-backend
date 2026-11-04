# Ficha — pricing-svc

## A. Identidad

Owner Vera; `origin/vera` HEAD `48afbf7a6845db4aaba6b58eb336396fa0e85ea7` (sin check run en ese SHA; último CI verde predecessor `3071a1a5687f4bdcf78cc7e561aa91e4e2550483`). Puerto 3002 / `PRICING_SVC_PORT`; schema `pricing` según migraciones. Proyecto/contenedor `g6-pricing-svc`; Compose genérico; runtime `/etc/g6-pricing-svc/runtime.env`; estado `/var/lib/g6-productos-ofertas/pricing-svc`. Oracle readiness 200 es observación histórica y no prueba el HEAD actual ni una operación comercial.

## B. Configuración runtime

| Variable | Requisito / origen | Validación |
|---|---|---|
| `NODE_ENV`, `PORT`, `PRICING_SVC_PORT` | Dockerfile genérico y Compose fijan production; Compose fija ambos puertos a 3002 | `config/environment.ts`, `verifyEnvironment`; port entero y válido |
| `DATABASE_URL` | requerida; Marco/DB owner suministra URL con credencial | URL Postgres válida, `sslmode=verify-full` fuera de pruebas locales; únicos parámetros permitidos `sslmode`, `sslrootcert` |
| `PGSSLMODE`, `PGSSLROOTCERT` | TLS/CA; ruta CA Compose `/run/g6-certs/supabase-server-root.crt` | ssl verify-full, CA parse X509; TLS global no puede deshabilitarse |
| `AUTH_ISSUER`,`AUTH_JWKS_URL` | opcionales, pero deben venir juntas si se configura auth | HTTPS URL fuera de test local; runtime.env |
| `GATEWAY_DEMO_NO_AUTH_ENABLED` | default false; demo controlada | producción true exige `PRICING_DEMO_PRODUCTION_CONFIRMED=true`; no habilitar por defecto |
| `PRICING_DEMO_PRODUCTION_CONFIRMED` | solo guard explícito de demo | bool |
| `NODE_TLS_REJECT_UNAUTHORIZED` | no debe ser `0` | rechazado si TLS global desactivado |

## C. Dependencias

PostgreSQL verificado mediante `PricingDatabase.check`; CA/TLS obligatorio. Servicio conectado `g6-http`, alias `pricing-svc`; AMQP no demostrado por backend master ni auditoría. Gateway upstream solo con ruta autorizada. Catalog demo puede requerir Pricing según `CATALOG_PRICING_URL`.

## D. HTTP / seguridad

Contrato OpenAPI docs `origin/master` SHA `c36bd9a...`, versión `0.6.0-rc.1`; código `pricing-read.controller.ts` implementa GET `/api/v1/precios/productos/{productoId}`, `/api/v1/precios/productos/{productoId}/programaciones`, `/api/v1/precios/skus/{sku}/programaciones`, `/api/v1/precios/importaciones/{batchId}`. Corroborar paridad y auth contra OpenAPI antes declarar completas. `/health/ready` prueba DB; `/health` liveness. JWT/scope como contrato. CI confirma liveness con base inaccesible/readiness 503 y test integración PostgreSQL desechable; Oracle tuvo readiness 200 pero sin smoke negocio.

## E. RabbitMQ

No se confirma publisher/consumer activo por master/corte Oracle. Consultar AsyncAPI antes de sumar; no deducir eventos de la responsabilidad de Pricing. Ver [matriz](../RABBITMQ_COMPATIBILIDAD.md).

## F. Persistencia

PostgreSQL con TLS verify-full. Registrar schema/rol/migraciones exactos desde la migración del SHA elegido; sin arranque con DDL. La CI incluye pruebas provider/persistence con PostgreSQL aislado.

## G. Pruebas y aceptación

`npm run build:pricing-svc`; `npm test -- apps/pricing-svc`; `npm run test:e2e -- apps/pricing-svc --reporter=verbose` (CI usa `PRICING_TEST_POSTGRES=1`); `npm run typecheck`; `npm run lint`; `bash ops/oracle/build-service.sh pricing-svc`; imagen/Compose genéricos; PostgreSQL con TLS, readiness y GET autorizado sobre fixture conocida. No usar Oracle para pruebas destructivas.

## H. Bloqueos y entrega

Vera debe asociar GET contractual a test DB real/fixture y capturar smoke de negocio; verificar rol/schema exactos. Gateway/Auth smoke y aprobación por Marco. No declarar readiness 200 como flujo comercial probado.

## Marketplace H4 — Pricing

G1 depende de `consultarPrecios` (`GET /api/v1/precios`) y `obtenerPrecioSku` (`GET /api/v1/precios/skus/{sku}`). No asumir integración real sin handler; el precio requiere SKU vendible autoritativo, canal y vigencia conforme al contrato. El BFF compone su DTO y G5 conserva el snapshot durable. Registrar la brecha y prueba Provider en la [matriz H4](../../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md); no inventar contexto/DTO.
