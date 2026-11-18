# Coordinación H5 de Promotions Gateway BFF e infraestructura

Entrega separada de los adaptadores de Promotions. Continúa #75 y conserva el piloto #234/#235 sin cambios. Ya se solicitaron las revisiones externas: [G5 #64](https://github.com/Taller-SW-Web/G5-Ventas-Postventas/issues/64) y [G7 #107](https://github.com/Taller-SW-Web/Modulo-de-Seguridad/issues/107). Esas solicitudes no equivalen a aceptación ni grant.

## Gateway y contratos

- Las tres rutas candidatas de consumo/restauración/consulta de cupón permanecen fuera de Nest/Gateway público. Incorporarlas únicamente tras contrato versionado revisado y definición de cliente/scope/allowlist G7. No añadir lógica de negocio al Gateway.
- Resolver arquitectura de las referencias heredadas api-gateway/bff en eventos de Catalog/Pricing/Inventory. Registrar por evento si existe consumidor/handler requerido y cómo se conserva su efecto. No omitirlo, atribuirlo automáticamente a G1 ni crear una cola sin handler aprobado.
- Coordinar con Inventory #240 la lectura del estado actual de reserva y su autorización; un PR de Inventory no homologa la frontera G5 por sí solo.

## Infraestructura a preparar y revisar

Namespace de destino por ambiente, región/costo/SKU y workloads deben confirmarse. El namespace del piloto aislado no es aprobación de infraestructura productiva.

| Cola candidata | Sender exclusivo previsto | Receiver previsto |
|---|---|---|
| g6.promotions.from.catalog | identidad de catalog-svc | identidad de promotions-svc |
| g6.promotions.from.pricing | identidad de pricing-svc | identidad de promotions-svc |
| g6.promotions.from.inventory | identidad de inventory-svc | identidad de promotions-svc |
| g6.promotions.commands | adaptador interno de Promotions | worker interno de Promotions |

Roles Azure Data Sender/Receiver mínimos al nivel de entidad; sin Data Owner en runtime ni secretos SAS para módulos externos. Verificar que nadie fuera del productor previsto pueda enviar a cada cola. La propiedad producer de un mensaje no autentica por sí sola.

Preparar configuración por servicio, identidades asignadas, ejecución continua/recuperación SQL sin tráfico HTTP, métricas de pendientes/reintentos/DLQ, alertas operativas y procedimiento de replay autorizado. No activar productores compartidos sin sus consumidores obligatorios ni ejecutar migraciones compartidas desde el bootstrap.

## Criterios de cierre

1. Tabla de rutas/handlers incluida BFF y respuesta explícita de arquitectura/integración.
2. Plan de colas/identidades/RBAC/configuración revisado por ambiente y cada owner; recursos reales comprobados por separado.
3. SQL candidato de operaciones/entregas Promotions revisado y probado en PostgreSQL descartable con roles mínimos. No se aplicó a Supabase compartido.
4. Pruebas Azure de acceso permitido/denegado, entrega/duplicados, caída, locks, recuperación y readiness; SHA exacto y configuración no secreta.
5. Plan de corte y conciliación de H4/H5. No suponer RabbitMQ operativo para reversión; definir detención segura y recuperación sin perder operaciones.
6. Smoke G7 positivo/negativo y E2E G5 cuando sus dependencias estén cerradas. No inferirlos de pruebas con dobles.

Esta coordinación no autoriza provisionar, conceder permisos, desplegar, borrar colas ni retirar contratos externos de forma unilateral. Preparación interna y fronteras externas se registran por separado. Responsables primarios por confirmar: arquitectura/integración G6, Infra y owners productores/consumidores.
