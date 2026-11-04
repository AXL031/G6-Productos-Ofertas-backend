# Eventos y RabbitMQ de Promotions — #75 / #33

Owner: Axel Cueva · rama `cueva` · 23/10/2026.

**IMPLEMENTAR_PARCIAL.** El transporte, los resultados de cupones y el dispatcher
transaccional están implementados y probados con PostgreSQL/RabbitMQ desechables.
Los cuatro writers de proyección propia están implementados; las proyecciones
productivas necesitan decoders de payload tipados y procedencia acordados;
el registro `ASSIGNED_EVENT_ADAPTERS` está vacío por defecto. La identidad AMQP,
evidencia de reserva/snapshot y elegibilidad productiva tampoco se sustituyen por
fixtures. Consumidor y pump siguen desactivados.

La continuación de los pasos 2/3 se detalla en
[ADAPTADORES-COMERCIALES.md](ADAPTADORES-COMERCIALES.md): writers concretos en
`src/coupons/assigned-projections.ts`, sin decoders externos inventados ni registro
productivo. El smoke los usa con decoders sintéticos explícitos; eso no prueba el
mapping del productor compartido.

## Normativa y bindings

Docs `51a5ce6e76bb0c61d93ef47416e46797bf5b9846`, AsyncAPI `0.6.0-rc.3`,
SPEC-005/006/007 y DEC-F-007/008/009/012. El generador existente produce los seis
contratos de cupones y los cuatro eventos asignados, con versión y hash de fuente.
Los payloads de cupones v2 se conservan; solo se actualizan los nombres físicos.

| Elemento | Valor contractual rc.3 |
| --- | --- |
| Cola principal | `po.promociones.q`, quorum durable, prefetch 20. |
| Comandos entrantes | `po.comandos.x`: `promotions.coupon.consumption.requested`, `promotions.coupon.restoration.requested`. |
| Eventos entrantes | `po.eventos.x`: `catalog.product.deactivated`, `catalog.sku.deactivated`, `pricing.price.changed`, `inventory.stock.changed`. |
| Resultados propios | `po.resultados.x`: consumption/restoration `.completed` y `.rejected`. |

El contrato rc.3 identifica la base como observada pero no homologada; retry/DLX
sigue candidato no aprobado. El servicio no declara exchanges, colas o bindings,
no crea permisos y no aprovisiona retry/DLQ. Solo los fixtures del broker desechable
crean esa topología para probarla. El probe pasivo consulta la cola rc.3, sin
declararla ni consumir mensajes. No se añaden eventos administrativos inexistentes.

## Dispatcher de eventos asignados

`PromotionsAssignedEventDispatcher` valida JSON UTF-8, tamaño, envelope, productor
autenticado independiente del payload, exchange, routing key y messageId cuando
está presente. Un `producer`, `appId` o `userId` declarado por el mensaje no concede
por sí mismo identidad. `PROMOTIONS_BROKER_IDENTITY` exige un adaptador autorizado;
su implementación por defecto rechaza.

El envelope genérico oficial no define qué campo contiene producto, SKU, precio,
stock o versión de su snapshot. Por eso cada adaptador debe validar su contenido
y aplicar únicamente una proyección local. Sin adaptador, payload válido no
equivale a evento procesado: no se crea Inbox ni se hace ACK.

Con un mapping disponible:

1. Iniciar transacción en el mismo pool propio con timeouts acotados.
2. Ejecutar `fn_begin_inbox` con handler estable y envelope completo.
3. Si existe un receipt completo idéntico, devolver replay sin aplicar de nuevo.
   Una entrada incompleta o un message_id con contenido distinto no permite ACK.
4. Aplicar la proyección mediante el mismo cliente y completar Inbox atómicamente.
5. Devolver éxito solo después del COMMIT. El consumidor confirma el mensaje en
   su propio canal después de esa resolución. Si falla, cierra el canal sin ACK;
   recuperación/retry requiere la política homologada, no una nueva política local.

Los guards oficiales de proyección impiden sobrescrituras antiguas y ambigüedad de
versión; no se modificaron. La prueba de esta entrega usa adaptadores sintéticos
explícitos para ejercitar esos guards, no un contrato externo inventado en `src/`.

## Cupones y Outbox

Se conserva el núcleo único existente: consumo/restauración, locks, recibos,
idempotencia de operación, Inbox, resultado durable y Outbox en una transacción.
El publisher usa confirms y publicaciones mandatory; no marca publicado ante
rechazo, retorno o timeout. Pérdida de ACK/reentrega no repite consumo/restauración.

`CouponRuntime` sigue sin iniciar consumidor ni pump por defecto. Su preflight
exige los cuatro mappings y una identidad autorizada, y conserva el bloqueo de
evidencia/eligibilidad de cupones. Configurar un booleano no sustituye esos gates.

## Pruebas reproducibles

```powershell
npm test -- apps/promotions-svc --maxWorkers=1
npm run build:promotions-svc
node apps/promotions-svc/test/coupons.isolated.smoke.mjs
node apps/promotions-svc/test/readiness.isolated.smoke.mjs
```

Los once escenarios previos de cupones se mantienen; la suite añade tres grupos:
los cuatro envelopes asignados con Inbox/proyección y conflicto de identidad;
rollback/retry/orden de versiones y mappings ausentes; routing real por la cola
compartida rc.3, ACK posterior al commit, duplicado y reentrega real tras ACK perdido.

Los campos `fixture_*` y la equivalencia `guest`/productor existen únicamente en
`test/support/assigned-event-checks.mjs`. No acreditan identidad productiva, grants,
homologación, precios ni elegibilidad reales. La suite verifica checksums de las
migraciones oficiales antes de aplicarlas solo a la base desechable.

El escenario adicional de los pasos 2/3 prueba los writers de `src/` con las cuatro
identidades normalizadas: producto/SKU separados, cambio de padre rechazado con
rollback de Inbox, coexistencia de canal global/específico y stock explícito.
Las comprobaciones anteriores se mantienen; sus resultados se registran por entrega.

## Dependencias específicas pendientes

| Owner | Operación | Condición verificable de desbloqueo |
| --- | --- | --- |
| Poma/Catálogo, Vera/Pricing y Taco/Inventario + arquitectura G6 | Cuatro proyecciones asignadas | Payloads/mappings tipados, versión y procedencia acordados, adaptadores implementados y pruebas de conformidad. |
| Marco/infra AMQP + G7, backend #29 | Consumidor/publicador compartidos | Identidad de productor, ACL/red/vhost y seis bindings verificados; homologación de la base rc.3 y política de recuperación. |
| G5/Ventas + Inventario + integración G6 | Consumo/restauración #33 | Reserva efectivamente confirmada y snapshot durable verificables, elegibilidad autoritativa, correlación y prueba bilateral de resultados v2. |
| Owner de despliegue, #111 | Activación desplegada | Configuración autorizada y evidencia de arranque/flujo por SHA en el entorno destino. |

Interno implementado/probado no equivale a integración autenticada, homologación
externa o despliegue. Estos últimos permanecen pendientes, sin escrituras en
broker/base compartidos ni cambios en contratos/migraciones históricas.
