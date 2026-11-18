# Revisión G7 de permisos HTTP H5 G6 y disponibilidad G5

Continuación específica H5 de Seguridad #78 y la solicitud G5 en Seguridad #51. Referencia: [contrato candidato con schemas y seguridad](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c1f7fabd16f46643b6dd6fb480bd925428da7f7c/contratos/http/PROPUESTA-OPERACIONES-CUPONES-H5.md), Docs `c1f7fabd16f46643b6dd6fb480bd925428da7f7c`.

## Permiso existente que requiere confirmación efectiva

Cliente modulo-ventas, tipo servicio, audiencia api-productos: confirmar/conceder inventario:disponibilidad:leer para GET /api/v1/inventario/disponibilidad. OpenAPI G6 contempla esta consulta para Ventas y Postventa; no se amplían permisos de reserva/consumo a modulo-postventa.

## Definiciones nuevas pendientes

- POST /api/v1/cupones/consumos, POST /api/v1/cupones/restauraciones y GET /api/v1/cupones/operaciones/{operationId}?order_id=...: inicialmente modulo-ventas. Acordar nombres mínimos de permisos y allowlist por operación. No reutilizar cupones:validar para mutaciones. No inventamos nombres de scopes nuevos en esta solicitud.
- GET candidato /api/v1/inventario/reservas/{reservaId}/estado?order_id=...: confirmar si inventario:operaciones:leer cubre esta operación o requiere otra definición. No inferir autorización desde el endpoint histórico de operaciones.
- Los GET nuevos comprueban pedido/cliente; conocer un UUID no autoriza acceder al recurso. G6 mantiene validación de firma, emisor, audiencia, expiración, tipo, cliente y scope/allowlist; 401/403 y 404 uniforme para recurso ajeno/ausente.

Service Bus es exclusivamente interno G6. Azure RBAC no sustituye scopes G7; no se entregan secretos del bus a otros módulos.

## Cierre verificable solicitado

1. Tabla aprobada cliente/audiencia/operación/scope y confirmación del permiso existente.
2. Responsable y mecanismo privado de provisioning; sin credenciales/JWT en el issue.
3. Una vez homologadas las rutas con G5, emisión real y pruebas positivas/negativas G7→G6 por SHA/ambiente. Definición contractual, concesión efectiva y E2E se registran separadamente.

La solicitud habilita revisión, no declara rutas H5 ya publicadas/desplegadas ni pide conceder permisos aún indefinidos. El runtime candidato de consumo sigue protegido por la dependencia de evidencia autoritativa de reserva/snapshot.
