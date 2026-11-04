# Matriz de red y dependencias G6

Fuentes físicas: auditoría Oracle solo lectura `2026-10-19 22:32:52–22:36:19 UTC` y Compose versionados en rama `castilla`. Estado `g6-http` observado: Gateway, Catalog, Pricing y Taxonomy; `g6-edge`: Caddy y Gateway. RabbitMQ (`g6-po_g6_backend`) está aislado. Las rutas Docker indicadas son aliases verificados/configurados en Compose, no equivalen a conectividad funcional probada.

| Componente | Puerto / loopback | g6-http | g6-edge | PostgreSQL / CA | RabbitMQ | HTTP upstream / consumidor | HTTPS público |
|---|---|---|---|---|---|---|---|
| api-gateway | 3000, `127.0.0.1` | sí, alias `api-gateway` | sí, `g6-api-gateway` | no se identifica DB propia | no consta | origins por `GATEWAY_*_URL`, readiness solo upstream con path explícito | Caddy→Gateway; routes según contrato/routing config |
| catalog-svc | 3001, loopback | sí, `catalog-svc` | no | Supabase PostgreSQL; CA ro | rama `poma` contempla AMQP, no está confirmado en master | taxonomy (`CATALOG_TAXONOMY_URL`); pricing condicional (`CATALOG_PRICING_URL`) | solo por Gateway si configurada/autorizada |
| pricing-svc | 3002, loopback | sí, `pricing-svc` | no | PostgreSQL/TLS `verify-full`; CA | rama `vera`/contrato por confirmar; no atribuir AMQP runtime observado | catalog puede llamar a Pricing solo para demo preview; ninguna ruta lateral autorizada por inferencia | solo por Gateway si ruta activa |
| price-audit-svc | 3003, loopback | pendiente de membresía/despliegue | no | No consta implementación DB en master | contrato requiere confirmar por operación; no hay configuración confirmada en master | ningún upstream confirmado | no demostrado |
| promotions-svc | 3004, loopback | pendiente | no | rama `cueva` contempla PostgreSQL schema promotions | código de rama usa English names; incompatibilidad; no alcanzable | eventos de inventario según rama `cueva`; no desplegado | no demostrado |
| inventory-svc | 3005, loopback | overlay opt-in versionado | no | PostgreSQL; env PG*/URL y CA en rama `taco` | rama `taco` candidata, Rabbit aislado y nombres/permiso pendiente | posibles eventos, no autorizar rutas HTTP sin contrato | no demostrado |
| taxonomy-svc | 3006, loopback | sí, `taxonomy-svc` | no | schema `taxonomy`, PostgreSQL con readiness lectura; CA ro | contrato puede especificar eventos; implementación master no debe presumirse | Catalog consume por HTTP privado cuando conectados; readiness observada 200 | `/api/v1/categorias` comprobada por Gateway; alcance limitado |
| combos-svc | 3007, loopback | pendiente | no | no consta DB en scaffold actual | no consta en `castilla` | no consta | no demostrado |
| bulk-svc | 3008, loopback | pendiente | no | no consta DB en scaffold actual | no consta en `castilla` | no consta | no demostrado |

**Acceso a PostgreSQL:** los runtime `env` existen para nueve según auditoría, pero sus valores no se leyeron. Solo Taxonomy tuvo readiness que consultó la base. No se confirmó validez de credenciales ni permisos para los otros servicios. Compose monta CA ro; el código debe validar `verify-full` y rol/schema propios.

**Acceso a RabbitMQ:** no existe ruta autorizada observada entre `g6-http` y `g6-po_g6_backend`; host AMQP está ligado a loopback y no debe exponerse públicamente. El único estado seguro es “inaccesible desde nuevos contenedores / mecanismo no aprobado”. Para desbloquear, owner de plataforma/Marco debe decidir y autorizar una red privada segmentada/adjunción controlada, alias, vhost y credenciales/permisos mínimos por servicio; después probar el camino desde contenedor. Ningún documento autoriza conectar redes ahora.

**Publicación externa:** puertos de servicios están enlazados a loopback. HTTPS pasa por Caddy en `g6-edge` a Gateway. No publicar 3000–3008 ni 5672/15672 globalmente. La captura auditada probó TCP 22/80/443 alcanzables y 3000/5672 en timeout desde el auditor; NSG OCI no fue inspeccionado.

Estado por servicio, SHA auditado, Docker health y HTTP probados se resumen en [`ESTADO_ACTUAL.md`](ESTADO_ACTUAL.md). Para preparar un servicio, revisar también su Compose efectivo y autorización individual en el momento de release.

## H4 Marketplace — lectura de estados

Las celdas de infraestructura describen solo el ambiente/SHA observados en la fecha de su corte. No equivalen a E2E G1. HTTP 200 aislado no acredita readiness estable, proveedor PostgreSQL configurado, grant ni funcionamiento funcional del contrato. Ver [`../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md`](../../integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md) para la calificación independiente por operación y [`ESTADO_SERVICIOS.md`](ESTADO_SERVICIOS.md) para el corte Oracle. No usar un SHA anterior a HEAD actual como CI de la rama.
