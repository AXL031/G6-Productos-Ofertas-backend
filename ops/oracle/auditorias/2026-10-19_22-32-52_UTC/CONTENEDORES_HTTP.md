# Contenedores y estado HTTP

**Fuentes:** `sudo -n docker ps -a`, `docker inspect` con campos seguros explícitos (sin variables de entorno), listeners del host y GET HTTP del 2026-10-19. El SHA en una imagen no prueba por sí mismo promoción ni salud.

## Contenedores

| Contenedor | Imagen/tag | Docker | Creado / iniciado UTC | Reinicios | Puertos | Redes / mounts |
|---|---|---|---|---:|---|---|
| `g6-api-gateway` | `api-gateway:9205eb455c4965a82ccb9fc4714cf976e4c059b0` | running, `unhealthy` | 2026-10-17 14:56:05 / 14:56:06 | 0 | `127.0.0.1:3000` | default, `g6-edge`, `g6-http`; CA PostgreSQL bind ro |
| `g6-catalog-svc` | `catalog-svc:9205eb455c4965a82ccb9fc4714cf976e4c059b0` | running, `healthy` | 2026-10-17 14:09:12 / 14:09:12 | 0 | `127.0.0.1:3001` | default, `g6-http`; CA PostgreSQL bind ro |
| `g6-pricing-svc` | `pricing-svc:2970df90babf2c8caa1849b179b02918fc74a005` | running, `healthy` | 2026-10-17 13:25:48 / 13:25:48 | 0 | `127.0.0.1:3002` | default, `g6-http`; CA PostgreSQL bind ro |
| `g6-taxonomy-svc` | `taxonomy-svc:97ca576282e93e8b35f4bc33b5cbcb972e63caef` | running, `healthy` | 2026-10-17 05:59:56 / 05:59:59 | 0 | `127.0.0.1:3006` | default, `g6-http`; CA PostgreSQL bind ro |
| `g6-caddy` | `caddy:2.11.6-alpine@sha256:d44355d3…` | running; no Docker healthcheck | 2026-10-16 15:49:06 / 15:49:07 | 0 | `0.0.0.0:80/443`, `[::]:80/443`, UDP 443 | `g6-edge`; config bind ro; config/data volumes |
| `g6-po-rabbitmq-1` | `rabbitmq:4.2.9-management` | running, `healthy` | 2026-10-15 15:54:51 / 15:54:52 | 0 | `127.0.0.1:5672/15672` | `g6-po_g6_backend`; persistent `rabbitmq_data` |

No existen contenedores G6 para `price-audit-svc`, `promotions-svc`, `inventory-svc`, `combos-svc` o `bulk-svc`. No hay listeners en 3003, 3004, 3005, 3007 o 3008.

## HTTP, readiness y dependencia

| Servicio | `/health` | Readiness / Docker health | GET negocio probado | Gateway/TLS | Clasificación |
|---|---|---|---|---|---|
| Gateway | 200 (`status=ok`) | Docker ejecuta `readiness.js`; falla: Catalog `not_ready`, Taxonomy `ready`, resto `not_configured`, cobertura `partial` | `/api/v1/categorias` 200; productos/precios/promociones/combos 401 sin autenticación | Categorías 200 por HTTPS; catch-all 503 | `HEALTH_OK_READINESS_PENDIENTE` |
| Catalog | 200 | Docker health solo consulta `/health`; `/health/ready` 503; `/health/readiness` 404 | `/api/v1/productos` directo 400 sin parámetros; Gateway 401; sin GET exitoso confirmado | Gateway enruta; negocio no confirmado | `HEALTH_OK_READINESS_PENDIENTE` |
| Pricing | 200 | Docker consulta `/health`; `/health/ready` 200 | Sin GET de negocio exitoso confirmado | No se acreditó upstream Gateway | `HEALTH_OK_READINESS_PENDIENTE` |
| Taxonomy | 200 | Docker consulta `/health`; `/health/readiness` y `/health/ready` 200 | `/api/v1/categorias` 200 directo y por Gateway; readiness implementada con dos lecturas PostgreSQL | HTTPS/Gateway 200 | `OPERATIVO_COMPROBADO` solo para lectura de categorías observada |
| Price Audit | Sin contenedor | No aplica | No aplica | No | `NO_DESPLEGADO` |
| Promotions | Sin contenedor | No aplica | No aplica | No | `NO_DESPLEGADO` |
| Inventory | Sin contenedor | No aplica | No aplica | No | `NO_DESPLEGADO` |
| Combos | Sin contenedor | No aplica | No aplica | No | `NO_DESPLEGADO` |
| Bulk | Sin contenedor | No aplica | No aplica | No | `NO_DESPLEGADO` |

Los códigos 401/400 representan las solicitudes sin autenticación o parámetros; no se eludieron ni se usaron credenciales. `/ready` no era el path real de readiness. El cuadro refleja los paths observados y las rutas documentadas en el runtime.
