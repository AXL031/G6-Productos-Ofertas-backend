# RabbitMQ y comparación contractual

**Fuentes:** comandos de consulta `rabbitmq-diagnostics`/`rabbitmqctl`; [AsyncAPI de docs](../../../../../docs/contratos/eventos/asyncapi.yaml) y [guía de topología](../../../../../docs/contratos/eventos/rabbitmq-topologia.md), leídos desde el working tree local de docs, que ya tenía modificaciones al iniciar y cuyo commit no se fijó; búsqueda literal de nombres en fuentes `backend/apps` y `backend/ops` de `castilla`. Las referencias contractuales se presentan como el contenido inspeccionado, no como homologación/publicación. No se publicaron, consumieron, purgaron ni reprocesaron mensajes.

## Estado observado

- `g6-po-rabbitmq-1`, imagen `rabbitmq:4.2.9-management`, servidor RabbitMQ 4.2.9, Docker `healthy`.
- Vhosts: `g6-productos-ofertas`, `g6`.
- Exchanges aplicación en el primer vhost: `po.comandos.x` topic durable; `po.eventos.x` topic durable; `po.resultados.x` topic durable; `po.sin-ruta.x` fanout durable.
- Once colas, todas quorum y durable: `po.combos.q`, `po.precios.q`, `po.sin-ruta.q`, `po.ventas.q`, `po.catalogo.q`, `po.auditoria-precios.q`, `po.taxonomia.q`, `po.pasarela.q`, `po.promociones.q`, `po.masivos.q`, `po.inventario.q`.
- Se enumeraron 57 bindings cuyo source es un exchange de aplicación; no se cuenta el exchange default.
- Al corte 22:35:55Z: `ready=0`, `unacked=0`, 0 consumidores y 0 conexiones.
- No había policies ni runtime parameters en ese vhost.
- `list_users` mostró: `g5_ventas`, `g6_admin`, `g6_auditoria_precios`, `g6_backend`, `g6_catalogo`, `g6_combos`, `g6_inventario`, `g6_masivos`, `g6_pasarela`, `g6_precios`, `g6_promociones`, `g6_taxonomia`. La consulta mostró solo nombres/tags, nunca contraseñas.
- Permisos listados en `g6-productos-ofertas` (configure / write / read):

| Usuario | Configure | Write | Read |
|---|---|---|---|
| `g5_ventas` | ninguno (`^$`) | `po.comandos.x` | `po.ventas.q` |
| `g6_auditoria_precios` | ninguno | ninguno | `po.auditoria-precios.q` |
| `g6_catalogo` | ninguno | `po.comandos.x`, `po.eventos.x`, `po.resultados.x` | `po.catalogo.q` |
| `g6_combos` | ninguno | ninguno | `po.combos.q` |
| `g6_inventario` | ninguno | `po.eventos.x`, `po.resultados.x` | `po.inventario.q` |
| `g6_masivos` | ninguno | `po.comandos.x` | `po.masivos.q` |
| `g6_pasarela` | ninguno | ninguno | `po.pasarela.q` |
| `g6_precios` | ninguno | `po.eventos.x`, `po.resultados.x` | `po.precios.q` |
| `g6_promociones` | ninguno | `po.resultados.x` | `po.promociones.q` |
| `g6_taxonomia` | ninguno | `po.comandos.x`, `po.eventos.x`, `po.resultados.x` | `po.taxonomia.q` |

`g6_admin` y `g6_backend` aparecieron como usuarios, pero no como filas de `list_permissions` para este vhost; su permiso efectivo no se infiere de esta lista. Los nombres/routing patterns anteriores son expresiones de permisos, no valores secretos.
- AMQP 5672 y Management 15672 están ligados a loopback; volumen `g6-po_rabbitmq_data` en `/var/lib/rabbitmq`.

## Retry/DLX y discrepancias

La topología física no incluye exchanges `po.reintentos.x` o `po.fallidos.x`, colas retry/DLQ, policies ni parámetros; tampoco aparecen `po.retry.x`, `po.dlx.x`, `po.catalog.q.retry` o `.dlq`. El gate retry/DLX sigue bloqueado.

El AsyncAPI observado usa nombres españoles para la base, coincidentes con Oracle, pero su bloque retry refiere nombres adicionales y `po.catalog.q`/colas `.retry`/`.dlq`, mientras sus colas principales usan `po.catalogo.q`. La guía topológica describe `po.reintentos.x`/`po.fallidos.x` como diseño pendiente. El owner contractual debe resolver esa inconsistencia; no se elige un nombre por inferencia.

El encargo mencionaba nombres ingleses (`po.commands.x`, `po.events.x`, `po.results.x`, `po.catalog.q`, `po.retry.x`, `po.dlx.x`). La búsqueda literal no los encontró en `backend/apps` ni `backend/ops` del checkout. No se leyeron runtime env files, así que no se atribuye un contenido a su configuración. Cero conexiones y consumidores no aporta evidencia de clientes activos.

**Desbloqueo:** owners de AsyncAPI/topología y responsable de aprobación deben reconciliar nombres y autorizar/probar la configuración antes de aprovisionarla. No se cambió topología ni se atribuyó homologación externa.
