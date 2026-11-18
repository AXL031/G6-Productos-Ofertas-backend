# Persistencia candidata H5 — Inventory Service Bus Basic

`0001_outbox_delivery.sql` define la tabla `inventory.outbox_delivery` para soportar la entrega punto a punto hacia Azure Service Bus Basic (sin tópicos ni suscripciones).

## Características
1. **No destructiva**: No altera migraciones H4 existentes, no realiza backfills y nunca se ejecuta en el bootstrap de la aplicación.
2. **Destinos aprobados (G6 Basic)**:
   - R11: `g6.catalog.from.inventory` (`inventory.sku.initialization.completed`, `inventory.sku.initialization.rejected`)
   - R12: `g6.combos.from.inventory` (`inventory.stock.changed`)
   - R13: `g6.promotions.from.inventory` (`inventory.stock.changed`)
   - (R02 / R10 Bulk permanece bloqueado por contrato pendiente; no se habilita en esta migración).
3. **Clave primaria compuesta**: `(message_id, destination)` asegura entrega idempotente independiente por consumidor.
4. **Lease y reintentos**: Soporta bloqueo distribuido transaccional (`FOR UPDATE SKIP LOCKED`) con token de lease y backoff exponencial acotado a 60 segundos. Mensajes que excedan el límite de 256 KB registran un fallo terminal recuperable sin reintentos infinitos.
5. **Permisos de seguridad**: Sólo `inventory_app` recibe SELECT, INSERT y UPDATE.
