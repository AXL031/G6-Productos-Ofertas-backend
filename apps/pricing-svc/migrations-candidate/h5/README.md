# Persistencia candidata del piloto H5

`0001_outbox_delivery.sql` añade únicamente `pricing.outbox_delivery`. No modifica migraciones H4, no hace backfill y no se ejecuta al arrancar Nest. Está limitada a la ruta aprobada para el laboratorio `g6.price-audit.from.pricing`, versión 1.

Aplicar con `po_pricing_owner` y el proceso de datos correspondiente a una base autorizada. El guard comprueba owner/schema; `pricing_app` recibe SELECT/INSERT/UPDATE solo sobre su tabla propia. No se conceden permisos sobre otros schemas. La FK se refiere al `message_id` único del Outbox existente. La PK por mensaje/destino impide duplicar la intención; el índice parcial sirve para recuperar pendientes y claims vencidos.

El writer de Pricing inserta hecho y entrega usando la misma transacción. El relay confirma por token/lease después del envío y no altera `pricing.outbox.published_at`. Retener tabla, mensajes e Inbox durante cualquier reversión. El proceso autorizado debe revisar la derivación física oficial de Pricing antes de aplicar esta candidata en una base compartida.

La prueba `ops/azure/service-bus/pilot.postgres.e2e-spec.ts` aplica esta candidata solo en un PostgreSQL descartable. Su éxito no afirma migración en Supabase ni otro ambiente remoto.
