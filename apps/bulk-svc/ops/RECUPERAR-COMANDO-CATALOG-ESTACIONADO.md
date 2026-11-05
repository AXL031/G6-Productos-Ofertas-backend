# Recuperación autorizada de comandos Catalog estacionados

El relay estaciona un comando después de ocho intentos sin resultado. La operación requiere a un operador con acceso PostgreSQL ya autorizado para Bulk y a un responsable de infraestructura RabbitMQ. No se crean grants, endpoints, colas ni bindings nuevos.

## Procedimiento

1. Localizar el mensaje con el ID estable:

   ```sql
   SELECT message_id, event_name, correlation_id, operation_id, attempts,
          last_error, payload
   FROM bulk.outbox
   WHERE message_id = '<message_id>';
   ```

   Confirmar que `event_name = 'catalog.bulk.upsert.requested'`, `last_error = 'CATALOG_ROUTE_REVIEW_REQUIRED'` y que `message_id`, `operation_id` y `payload` coinciden con la solicitud original. No se reescriben esas identidades ni el payload.

2. El responsable RabbitMQ verifica mediante el mecanismo operativo ya aprobado que el binding efectivo de `po.comandos.x` para `catalog.bulk.upsert.requested` llega a `po.catalog.q`, y que el consumidor Catalog está activo y procesando. Anotar referencias verificables (ticket/ejecución/observación con hora); el CLI no pretende verificar topología con permisos que Bulk no posee.

3. Comprobar si el resultado ya fue recibido, aplicado o persistido para replay:

   ```sql
   SELECT handler, event_name, result, payload
   FROM bulk.inbox
   WHERE correlation_id = '<correlation_id>'
     AND handler IN ('bulk.catalog.bulk-upsert.result', 'bulk.contract-result-replay')
     AND payload->>'causation_id' = '<message_id>';
   ```

   Si hay una fila, no reactivar: el consumidor/replay debe resolverla. El ejecutable también hace esta comprobación bajo bloqueo transaccional; la consulta operativa previa sirve como evidencia humana.

4. Con autorización registrada en el sistema operativo del equipo, ejecutar desde la raíz del backend ya compilado. El motivo debe identificar al operador y la referencia de autorización. Usar el `DATABASE_URL` autorizado vigente; no copiarlo a argumentos ni al ticket:

   ```powershell
   node apps/bulk-svc/ops/recover-parked-catalog-command.mjs `
     '<message_id>' `
     '<motivo y referencia de autorización>' `
     '<referencia verificable del binding habilitado>' `
     '<referencia verificable del consumidor activo>'
   ```

   Solo una fila aún estacionada puede cambiar. La transacción bloquea el outbox, reconsulta resultados correlacionados, registra actor (`current_user` de PostgreSQL), motivo y evidencias en `bulk.inbox`, y programa el mismo comando para reintento inmediato. Ejecuciones concurrentes posteriores devuelven `NOT_PARKED`; si ya hay un resultado correlacionado aplicado o pendiente de replay, devuelve `RESULT_ALREADY_RECORDED`. No repetir tras esos resultados.

5. Verificar que el relay publicó el mismo `message_id`, `operation_id` y payload, y que Catalog persiste el resultado correlacionado. El outbox solo se marca entregado al aplicar ese resultado.

Si PostgreSQL, la evidencia o RabbitMQ no pueden verificarse, no ejecutar el CLI. Mantener el mensaje estacionado y escalar a los owners de Bulk/Catalog/Infraestructura.
