# Compatibilidad RabbitMQ: contrato, topología y candidatos

## Estados que no se deben mezclar

- **Contrato oficial consultado:** AsyncAPI `0.6.0-rc.4` del repositorio de documentación. El SHA exacto debe registrarse desde el commit donde rc.4 quede publicado; el corte local previo citaba `0.6.0-rc.2` sobre `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`. No consta homologación externa.
- **Topología física observada:** auditoría Oracle `2026-10-19 22:32:52 UTC`, RabbitMQ 4.2.9, vhost `g6-productos-ofertas`: exchanges `po.comandos.x` (topic), `po.eventos.x` (topic), `po.resultados.x` (topic), `po.sin-ruta.x` (fanout); 11 colas, 57 bindings, cero mensajes, consumidores y conexiones. Broker aislado; no hay ruta autorizada desde las redes de aplicación. No existe retry/DLX.
- **Código candidato:** ramas personales indicadas abajo, no equivalen a contrato homologado ni a despliegue.

## Nombres exactos y bloqueo

| Flujo | Contrato/topología candidate | Físico observado | Código candidato y estado |
|---|---|---|---|
| Exchanges base | AsyncAPI usa `po.commands.x`, `po.events.x`, `po.results.x`; documenta candidatos de unrouted/retry/DLQ. | `po.comandos.x`, `po.eventos.x`, `po.resultados.x`, `po.sin-ruta.x`. | Inventory Taco publica en `po.eventos.x` o `po.resultados.x` (nombres físicos españoles, alineado desde PR #149). Catalog Poma y Promotions Cueva conservaban nombres ingleses en el corte anterior; su estado actual debe revalidarse con sus owners antes de declarar compatibilidad. |
| Cola Catalog | AsyncAPI menciona `po.catalog.q`; topología física declara `po.catalogo.q`. | `po.catalogo.q`; usuario físico `g6_catalogo` lee esa cola. | Catalog Poma consume `po.catalog.q`; no coincide con la cola física. Bloqueo para conectar/consumir. |
| Cola Inventory | Nomenclatura física `po.inventario.q`, adoptada en código y contrato. | `po.inventario.q`; usuario físico `g6_inventario` lee esa cola. | Inventory Taco consume `po.inventario.q` desde la PR #149 (SHA `6ef2005`). **Alineado en código y CI**; conectividad real a Oracle no verificada. |
| Cola Promotions | Código candidate `po.promotions.q`; la cola contractual y física española difieren. | `po.promociones.q`; usuario `g6_promociones` la lee y puede escribir solo `po.resultados.x`. | Promotions Cueva hace `checkQueue`/consume en `po.promotions.q`, publica `po.results.x`. Tanto cola como permiso de publicación chocan con la topología/ACL observada. Bloqueo. |
| Cola Price Audit | AsyncAPI/topología deben cotejarse con el path/evento aplicable; no inferir consumo por existir cola. | `po.auditoria-precios.q`; usuario físico `g6_auditoria_precios` con lectura observada. | HEAD Vera no implementa productor/consumidor. Ninguna conexión habilitada. |
| Cola Taxonomy | La topología contractual candidata debe fijar queue y bindings. | `po.taxonomia.q`; el usuario físico `g6_taxonomia` tiene lectura y permisos de escritura en exchanges físicos base. | HEAD Lopez no registra productor/consumidor AMQP. |
| Retry / DLQ | La documentación candidata usa nombres ingleses, incluidos `po.retry.x`, `po.dlx.x` y colas `.retry`/`.dlq`; revisar AsyncAPI exacta antes de aceptar. | No existen exchanges, colas ni policies retry/DLX. | Catalog Poma referencia `po.retry.x`/`po.dlx.x`; bloqueado. No inventar TTL, bindings, requeue, ACK ni permisos. |
| Routing keys | AsyncAPI define nombres de mensajes; verificar versión y payload exactos por operación. | 57 bindings observados, pero no hacen compatibles por sí solos nombres/routing candidate. | Catalog publica la propiedad `message.name` como routing key; ejemplos de código: `pricing.product.initialization.requested`, `inventory.sku.initialization.requested`, `catalog.product.deactivated`. Inventory utiliza `row.event_type` como routing key. Promotions comandos: `promotions.coupon.consumption.requested`, `promotions.coupon.restoration.requested`; resultados candidate: `promotions.coupon.consumption.completed/rejected` y `promotions.coupon.restoration.completed/rejected`. No habilitar hasta correspondencia con canales, bindings y permisos acordados. |

Los nombres físicos no son alias de los nombres ingleses. No se ha verificado conectividad de contenedor al broker; permisos enumerados en la auditoría describen ACL físicas, no autorización para adaptarlas. Una diferencia de exchange/queue/routing key, falta de permisos o falta de red que impida conectar/publicar/consumir es **bloqueo de deploy del flujo AMQP**. Mantener desplegables los flujos HTTP/DB independientes cuando el servicio lo permita. Marco/owner de contrato debe obtener la reconciliación y autorización aplicables antes de cambiar broker o interfaces compartidas.

## Niveles de evidencia (Inventory, 2026-11-03)

| Nivel | Estado | Evidencia |
|---|---|---|
| Nomenclatura física corregida y fusionada | **Cumplido** | PR #149, SHA `6ef2005c7f29b11ef15021a2f5d42b4a17b8ae05`, fusionada en `master@fc9d5c0`. Código usa `po.inventario.q`, `po.eventos.x`, `po.resultados.x`. |
| Código y CI acreditados por SHA | **Cumplido** | CI run `41494379276`, 16/16 jobs, incluida suite real PostgreSQL/RabbitMQ desechable. |
| Validación con PostgreSQL/RabbitMQ desechables | **Cumplido** | Suites de integración real en CI; no sustituyen Oracle. |
| Conectividad real a Oracle | **Pendiente** | TCP 22 con timeout desde IP dinámica; Marco no autoriza abrir SSH públicamente. Vía prevista: Tailscale o túnel previamente provisionado. |
| Homologación AMQP externa | **Pendiente** | Requiere verificación bilateral de canales, bindings, routing keys y ACL. |
| Retry/DLX operativo | **Pendiente** | No existen exchanges, colas ni policies de retry/DLX en Oracle; no se crean sin autorización independiente. |

La coincidencia de nomenclatura **no** acredita despliegue, conexión ni homologación.
