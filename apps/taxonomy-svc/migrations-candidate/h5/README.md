# Outbox H5 de Taxonomy

Aplicar 0001 únicamente como po_taxonomy_owner sobre su schema y mediante el proceso de datos autorizado. La migración añade un marcador a outbox y una tabla de entregas por destinatario. No genera un backfill. El marcador de filas históricas es RABBITMQ.

El runtime H5 usa MESSAGING_PROVIDER=AZURE_SERVICE_BUS y TAXONOMY_SERVICE_BUS_ENABLED=true. Requiere SERVICE_BUS_NAMESPACE_FQDN y, en producción, identidad administrada, G7_AUTHENTICATED y habilitación general H5. Deben estar ausentes RABBITMQ_URL y TAXONOMY_CATALOG_AMQP_USER. PostgreSQL recibe la opción de sesión g6.taxonomy_messaging. Se comprueba el marcador en la conexión real, la tabla y el trigger antes de exponer HTTP. Verificar compatibilidad con el pooler y con el rol runtime en el ambiente destino.

TAXONOMY_SERVICE_BUS_ENABLED=false pausa envío y consumo del runtime H5. La selección Azure continúa registrando los hechos nuevos con intención de entrega H5. Antes de cortar, detener réplicas con código anterior, reconciliar y drenar los pendientes H4, y probar el circuito completo con Catalog. Antes de volver a H4, conservar y conciliar las entregas H5 de forma independiente. El publicador H4 de esta versión solo reclama sus filas, incluso cuando ambos historiales permanecen en SQL.

El flujo conserva orden causal por operación. Una entrega terminal sin envío queda pendiente de revisión y bloquea las siguientes de la misma operación. El resto continúa. Monitorizar edad del Outbox, DLQ y disponibilidad de enlaces.
