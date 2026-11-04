# Estado operativo actual de Oracle

**Observación base:** 2026-10-19 22:32:52–22:36:19 UTC (17:32:52–17:36:19 Lima), auditoría SSH de solo lectura. **Complemento posterior:** HTTPS/SSH de solo lectura 2026-10-20 (detalles al final). La auditoría fechada no se reescribió. El SHA de `master` verificado al revisar fue `9205eb455c4965a82ccb9fc4714cf976e4c059b0`.

Este resumen refleja solo las comprobaciones enumeradas en la [auditoría completa](auditorias/2026-10-19_22-32-52_UTC/RESUMEN.md). Los documentos del 17 de octubre siguen siendo evidencia histórica y no fueron reescritos.

## Lectura rápida

- **VM:** Ubuntu 24.04.5 LTS, kernel `7.0.0-1013-oracle`, 4 vCPU, 11 GiB RAM, 10 GiB disponibles, sin swap, 40 GiB libres en `/`; carga 0.12/0.15/0.15 y NTP sincronizado. No hay presión observada; capacidad para nueve servicios no está demostrada mediante carga o límites.
- **Contenedores:** Caddy, RabbitMQ, Gateway, Catalog, Pricing y Taxonomy están presentes; Gateway está `unhealthy`; hay cinco servicios G6 no desplegados.
- **HTTP:** HTTPS público llega a Caddy. `/api/v1/categorias` responde 200 vía Gateway. El handler de respaldo de Caddy responde 503 estático para rutas no configuradas.
- **RabbitMQ:** vhosts `g6-productos-ofertas` y `g6`; 4 exchanges de aplicación, 11 colas quorum y 57 bindings; 0 mensajes, 0 consumidores y 0 conexiones al corte. No se encontró infraestructura retry/DLX.
- **CI/CD:** las nueve filas de `services.psv` permiten selección manual; las nueve autorizaciones automáticas son `false`. Ejecutores remotos informan v4/registro v2 y sus checksums coinciden con `castilla`. Hay Deployments `success` para los cuatro servicios activos, pero eso no prueba readiness actual ni rollback ensayado.
- **Seguridad:** `runtime.env` existe para los nueve servicios, permisos `0640`; no se leyó ningún valor. Los cuatro contenedores HTTP observados montan la CA de PostgreSQL como solo lectura. Conectividad Supabase de Catalog/Pricing no está demostrada; Taxonomy da evidencia de readiness con consultas de lectura.
- **OCI:** NSG/Security Lists no consultadas. Desde el equipo auditor se alcanzaron TCP 22, 80 y 443; 3000 y 5672 expiraron. Esto no atribuye reglas concretas a OCI.

## Estado de los nueve componentes

| Servicio (puerto) | Desplegado / Docker health | Readiness observada | GET negocio / Gateway | SHA/tag | Estado operativo |
|---|---|---|---|---|---|
| `api-gateway` (3000) | Sí / `unhealthy` | Healthcheck falla: Catalog `not_ready`, Taxonomy `ready`, resto `not_configured`, cobertura `partial` | `/health` 200; `/api/v1/categorias` 200 por Gateway; productos/precios/promociones/combos 401 sin autenticación | `9205eb455c4965a82ccb9fc4714cf976e4c059b0` | `HEALTH_OK_READINESS_PENDIENTE` |
| `catalog-svc` (3001) | Sí / `healthy` | `/health/ready` 503; `/health/readiness` 404 | `/api/v1/productos` directo 400 sin parámetros; vía Gateway 401; no se confirma GET funcional | `9205eb455c4965a82ccb9fc4714cf976e4c059b0` | `HEALTH_OK_READINESS_PENDIENTE` |
| `pricing-svc` (3002) | Sí / `healthy` | `/health/ready` 200 | Sin GET de negocio exitoso ni acceso por Gateway demostrado | `2970df90babf2c8caa1849b179b02918fc74a005` | `HEALTH_OK_READINESS_PENDIENTE` |
| `price-audit-svc` (3003) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `promotions-svc` (3004) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `inventory-svc` (3005) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `taxonomy-svc` (3006) | Sí / `healthy` | `/health/readiness` 200; `/health/ready` 200 | `GET /api/v1/categorias` 200 directo y por Gateway; readiness implementada con consultas PostgreSQL | `97ca576282e93e8b35f4bc33b5cbcb972e63caef` | `OPERATIVO_COMPROBADO` solo para lectura de categorías en el alcance observado |
| `combos-svc` (3007) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |
| `bulk-svc` (3008) | No | No aplica | Puerto no escucha; sin Gateway | — | `NO_DESPLEGADO` |

## Infraestructura transversal

| Componente | Confirmado | Pendiente / límite |
|---|---|---|
| Caddy 2.11.6 | Activo, `g6-edge`; puertos 80/443 globales; TLS Let's Encrypt YE1 válido hasta 2027-01-14; DNS `157.137.205.218`; Caddy → Gateway `/health` 200 | Sin healthcheck Docker; handler general responde 503; no todas las APIs tienen ruta pública |
| RabbitMQ 4.2.9-management | HEALTHY, volumen persistente, red privada, AMQP/Management solo loopback; vhost y usuarios/permisos presentes | Sin conexiones/consumidores; retry/DLX ausente; no se probaron clientes |
| `g6-edge` | Gateway y Caddy conectados | NSG OCI no observado |
| `g6-http` | Gateway, Catalog, Pricing y Taxonomy conectados | No se probó comunicación de cada par desde contenedores |
| Supabase CA | Host `0444`; montada en los cuatro servicios HTTP como bind ro | No se leyeron runtime values; Catalog/Pricing sin readiness satisfactoria/comprobación de negocio |

## Seguimiento

1. **P1:** resolver Catalog readiness 503 y Gateway unhealthy antes de declarar Gateway listo.
2. **P1:** reconciliar los nombres retry/DLX y su gate contractual antes de aprovisionar.
3. **P1:** completar los cinco servicios ausentes con SHA/CI, runtime, readiness y smoke de lectura por servicio; CD automático permanece desactivado.
4. **P2:** verificar integración de Pricing/Gateway, auth funcional, NSG/Security Lists OCI y rollback en ventana aprobada.
5. **P3:** evaluar límites de recursos/swap bajo carga representativa; este corte no mostró presión.

## Hito 4 — brecha de evidencia al 31 de octubre

- **CI/CD:** CI exitosa identificada para SHA de las cuatro imágenes activas; los Deployments GitHub reportan `success`. Falta demostrar readiness actual de Gateway/Catalog, rollback ejecutado y despliegue funcional de los cinco componentes ausentes. La publicación automática sigue apagada.
- **APIs:** hay una lectura de categorías comprobada por HTTPS/Gateway; respuestas sin autenticación en otras rutas no son smoke funcional. No se acredita el API de nueve componentes.
- **Demo funcional:** no se ejecutó ni se presume una demo E2E. La lectura de categorías es una prueba parcial, no evidencia de flujo comercial integrado.
- **Seguridad:** TLS y montajes CA/permissions están observados; el contenido/validez runtime se dejó intacto y por eso no fue verificado. Faltan NSG/Security Lists OCI, readiness de dependencias por servicio y autenticación E2E autorizada.

## Informe detallado

- [Resumen](auditorias/2026-10-19_22-32-52_UTC/RESUMEN.md) · [VM](auditorias/2026-10-19_22-32-52_UTC/INVENTARIO_VM.md) · [Contenedores y HTTP](auditorias/2026-10-19_22-32-52_UTC/CONTENEDORES_HTTP.md)
- [Redes y HTTPS](auditorias/2026-10-19_22-32-52_UTC/REDES_CADDY_HTTPS.md) · [RabbitMQ](auditorias/2026-10-19_22-32-52_UTC/RABBITMQ.md) · [CI/CD](auditorias/2026-10-19_22-32-52_UTC/CICD.md)
- [Seguridad](auditorias/2026-10-19_22-32-52_UTC/SEGURIDAD.md) · [Hallazgos](auditorias/2026-10-19_22-32-52_UTC/HALLAZGOS.md) · [Evidencias](auditorias/2026-10-19_22-32-52_UTC/EVIDENCIAS.md)

## Evidencia complementaria — 2026-10-20

No se reescriben las observaciones históricas del 19-oct. A las **00:08:47–00:08:51 UTC**, desde PowerShell con `curl.exe` (TLS verificado por defecto, sin flags de omisión), las tres solicitudes GET públicas y sin autenticación dieron `ssl_verify_result=0` y `Content-Type: application/json; charset=utf-8`:

| Solicitud | HTTP / tiempo | Respuesta observada |
|---|---:|---|
| `GET /api/v1/productos?canal=MARKETPLACE` | 200 / 13.021927 s | JSON `{items,pagina,tamanio,total}`; página 1, tamaño 20, 15 items, total 15. Incluye Nike Academy (`product_id=2ee6399e-2333-5916-847b-f6d2a0f03527`, slug `nike-academy-hv4386-100`). |
| `GET /api/v1/categorias` | 200 / 1.936968 s | JSON `{categories}`, 8 categorías; primera `Balones`, `ACTIVA` (`categoria_id=fcb3cac1-b14a-b935-fc1a-c147b878a5c6`). La atiende Taxonomy vía Gateway. |
| `GET /api/v1/productos/por-slug/nike-academy-hv4386-100?canal=MARKETPLACE` | 200 / 3.163814 s | JSON con `product_id=2ee6399e-2333-5916-847b-f6d2a0f03527`, slug `nike-academy-hv4386-100`, nombre Nike Academy, SKU base `NIK-ACADEMY-HV4386-05`, precio regular 129.9 PEN, sin oferta, cero variantes y una imagen. |

La lista y el detalle muestran datos comerciales para esas lecturas, no cobertura de todos los casos de Catalog. La respuesta positiva procede del contenedor desplegado `catalog-svc:9205eb455c4965a82ccb9fc4714cf976e4c059b0`; no prueba que la rama candidata Poma `a81f2d5` esté desplegada.

### Estado de contenedores y readiness consultado por SSH

Consultas SSH de solo lectura, sin leer `runtime.env`, observaron el 2026-10-20 00:09 UTC: Gateway, Catalog, Pricing y Taxonomy activos y Docker `healthy`; imágenes tagueadas respectivamente `9205eb4`, `9205eb4`, `2970df9` y `97ca576`. Caddy y RabbitMQ también estaban activos. `g6-http` incluye los cuatro servicios HTTP; RabbitMQ está únicamente en `g6-po_g6_backend`, sin red compartida con los servicios.

Desde dentro de los contenedores, Pricing `/health/ready` y Taxonomy `/health/ready` devolvieron 200. Catalog readiness fue intermitente durante la observación: un GET interno respondió 503 a las 00:07:06 y GETs a las 00:09:31 respondieron 200 tanto en localhost del contenedor como desde el alias `catalog-svc` visto por Gateway. El healthcheck Docker de Gateway también alternó `ready`/`not_ready`, con cobertura `partial`; su comprobación HTTP directa a `/health/ready` dio 404, pues el contenedor ejecuta el bundle de readiness y no expone esa ruta. Por tanto, el `healthy` Docker no acredita readiness HTTP estable ni los upstreams no configurados.

Las respuestas públicas 200 confirman Caddy→Gateway→rutas de demo funcionales para esta observación. No resuelven por sí mismas la intermitencia de readiness de Catalog ni permiten atribuir su causa a Caddy, Gateway, datos o acceso Supabase. No se alteraron VM, broker ni servicios.
