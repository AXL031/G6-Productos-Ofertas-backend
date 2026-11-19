# Contrato candidato interno de G6 para Bulk, Inventory y Pricing

El equipo del fork prepara el contrato, la implementación y la validación interna de estos flujos. Esta propuesta se adjunta a una revisión de AsyncAPI. El documento vigente mantiene ambos comandos en `BLOCKED_CONTRACT` con `GenericData`. Las reglas propuestas quedan pendientes de adopción explícita en el AsyncAPI de G6. [AsyncAPI vigente](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/contratos/eventos/asyncapi.yaml)

Los [esquemas de payload](BULK-DOMINIOS-H5.schemas.json) fijan la estructura candidata. Todos usan el `MessageEnvelope` publicado y proponen `schema_version: 2` para identificar el cambio de payload. Ningún módulo externo participa en R02, R03, R10 o R14.

| Flujo y cola Basic | Nombre | Tipo y esquema de `data` |
| --- | --- | --- |
| R02 · `g6.inventory.from.bulk` | `inventory.bulk.stock.adjust.requested` | `command` · `InventoryRequest` |
| R10 · `g6.bulk.from.inventory` | `inventory.bulk.stock.adjust.completed` | `result` · `InventoryApplied` |
| R10 · `g6.bulk.from.inventory` | `inventory.bulk.stock.adjust.rejected` | `result` · `InventoryRejected` |
| R10 · `g6.bulk.from.inventory` | `inventory.stock.adjusted` | `event` · `InventoryApplied`, solo cuando cambia el saldo |
| R03 · `g6.pricing.from.bulk` | `pricing.bulk.price.apply.requested` | `command` · `PricingRequest` |
| R14 · `g6.bulk.from.pricing` | `pricing.bulk.price.apply.completed` | `result` · `PricingApplied` |
| R14 · `g6.bulk.from.pricing` | `pricing.bulk.price.apply.rejected` | `result` · `PricingRejected` |

## R02 y R10. Aplicar stock inicial

Bulk crea una intención por fila, SKU y ubicación una vez que Catalog ha confirmado la fila y se ha confirmado la inicialización del SKU vendible correspondiente. La ubicación viene de Inventory por el mecanismo autorizado. La inicialización actual admite saldo cero en versión cero. Una fila con stock positivo requiere evidencia de saldo y versión para la ubicación solicitada antes de emitir R02. Una inicialización que solo registró identidad carece de esa evidencia. Si falta la ubicación, Bulk aplica la regla `DEFAULT_LOCATION_REQUIRED` del flujo existente. El SKU padre de un producto con variantes queda fuera del ajuste. [SPEC-001](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/requisitos/specs/SPEC-001-carga-exportacion-masiva-productos.md)

Inventory reutiliza el motor de ajuste absoluto. Bloquea el saldo, compara `expected_stock_version` y verifica que `target_on_hand` cubra reservas y bloqueos. Conserva la versión si el saldo ya coincide. Cuando el saldo cambia, registra el movimiento y la nueva versión en la misma transacción que el resultado terminal y sus entregas Outbox. El resultado de rechazo usa los códigos del motor existente. Bulk compara el SKU, ubicación y la causalidad con su intención persistida antes de dar por conciliado el ajuste.

`inventory.stock.adjusted` informa del movimiento efectivo. Solo `inventory.bulk.stock.adjust.completed` o `.rejected` resuelve la operación de Bulk. `inventory.stock.changed` conserva la semántica de snapshot para sus consumidores vigentes.

```json
{
  "batch_id": "3fab44ac-4064-4f73-a0c4-7daa65421be7",
  "row_operation_id": "6bd08702-7570-4664-8ebe-4b512bcb4b2f",
  "sku": "TALLER-ROJO-M",
  "location_id": "299f5de1-57cd-4f3a-9602-d9c0c67a26da",
  "expected_stock_version": 0,
  "target_on_hand": 12
}
```

Con cero reservados y bloqueados, el resultado aplicado devuelve `on_hand=12`, `available=12` y `stock_version=1`. Si el saldo ya tiene versión 1 al recibir la orden original, el resultado terminal es `VERSION_STALE`. Un intento con la versión vigente constituye una nueva intención expresamente conciliada.

## R03 y R14. Actualizar el precio base por lote

La propuesta limita R03 a la actualización condicionada de un precio base global existente del producto. El precio inicial del alta sigue el circuito publicado de Catalog a Pricing, con herencia de las variantes. La plantilla general de SPEC-001 no acepta precio en modo `ACTUALIZACION`. Para emitir R03 se necesita un origen de admisión aprobado para actualización masiva de precios, que capture el actor autenticado y la versión leída de Pricing. El candidato no crea un endpoint ni amplía la plantilla general. [SPEC-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md)

Pricing compara la versión bajo bloqueo, aplica las reglas de vigencia y conserva la oferta existente cuando sea compatible. Una oferta incompatible provoca el rechazo del cambio completo. En éxito, guarda el precio, actor, motivo, versión, hecho auditable `pricing.price.changed` y resultado R14 en la frontera transaccional de Pricing. El circuito del piloto continúa por su entrega ya definida. Bulk concilia contra la intención durable por producto y versión.

```json
{
  "batch_id": "3fab44ac-4064-4f73-a0c4-7daa65421be7",
  "row_operation_id": "6bd08702-7570-4664-8ebe-4b512bcb4b2f",
  "product_id": "3b803e05-ae51-4646-8eb2-dfa1f511db0c",
  "channel_id": null,
  "expected_price_version": 4,
  "precio_regular": 125.5,
  "moneda": "PEN",
  "motivo_cambio": "Actualización por lista comercial",
  "actor_user_id": "cc767b4c-21b6-4990-8eb3-3f0581ad7485"
}
```

El resultado aplicado conserva la fila y el producto, devuelve `status=APPLIED` y `price_version=5`. Si Pricing encuentra una versión distinta, responde `VERSION_CONFLICT`.

## Entrega, recuperación y aceptación

- El emisor fija `message_id`, `operation_id`, `correlation_id` y payload al admitir el comando. El resultado conserva operación y correlación y usa como `causation_id` el mensaje del comando. Cada resultado y hecho tiene su propio `message_id`.
- Productor y consumidor comparan la intención durable antes de resolver un duplicado. Una identidad repetida con otro contenido se aísla en DLQ sin alterar el efecto comercial original. El Inbox, el efecto y la entrega de respuesta se persisten antes de completar la recepción. Los fallos técnicos mantienen el reintento con las mismas identidades.
- Bulk proyecta por fila solo resultados del intento admitido. Espera todas las dependencias requeridas, conserva efectos de otros dominios ante un fallo y deja la conciliación visible. Para el alta multidominio, la propuesta es entregar a Bulk una copia de los resultados tipados de inicialización en las colas de su dominio. R04 necesita una versión que pueda indicar qué operaciones de preparación pertenecen a cada fila. El resultado de Inventory necesita identificar la ubicación y la versión observada si existe saldo. Catalog seguirá recibiendo los resultados para su preparación. El contrato debe plasmar estas relaciones antes de activar el alta.
- La aceptación del fork exige casos de éxito y rechazo, reentrega en ambos sentidos, versiones obsoletas, resultado ajeno o de intento previo, retiro y recuperación de DLQ, y verificación de tamaño en el SDK Basic. Infra aplica Sender/Receiver por cola en el laboratorio. Los cuatro flujos se mantienen desactivados hasta contar con contrato adoptado y evidencia bilateral.

### Infraestructura de laboratorio

El 19 de noviembre de 2026, el plan incremental de `ops/azure/service-bus/h5-integration.bicep` creó las cuatro colas de la tabla y sus ocho asignaciones RBAC. La comprobación por ámbito verificó un Sender del emisor y un Receiver del consumidor para cada cola. El espacio dedicado quedó con 18 colas, cero mensajes activos y cero en DLQ. Esta evidencia acredita topología y RBAC de laboratorio. El contrato oficial aún carece de payloads ejecutables para estos comandos.
