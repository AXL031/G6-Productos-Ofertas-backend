# Revisión G5 de la frontera HTTP H5 con G6

Continuamos los acuerdos de G5 #51. Solicitamos revisión explícita del [contrato candidato completo](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c1f7fabd16f46643b6dd6fb480bd925428da7f7c/contratos/http/PROPUESTA-OPERACIONES-CUPONES-H5.md), Docs `c1f7fabd16f46643b6dd6fb480bd925428da7f7c`, y su [matriz de 13 mensajes](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c1f7fabd16f46643b6dd6fb480bd925428da7f7c/integraciones/MATRIZ-EXTERNOS-ASYNCAPI-H5.md).

La arquitectura G6 adoptada usa Service Bus Basic exclusivamente interno. G5 usaría HTTPS/JWT con audiencia api-productos, sin credenciales del bus. No se atribuye aceptación G5 ni se declara el reemplazo desplegado.

## Bloques que solicitamos aprobar o corregir

1. Conservar las operaciones HTTP de reserva, confirmación y liberación. HTTP 202 solo admite; GET /api/v1/inventario/operaciones/{operationId} recupera resultado durable. Crear reserva no consume definitivamente stock.
2. Nuevos POST /api/v1/cupones/consumos y /api/v1/cupones/restauraciones, y GET /api/v1/cupones/operaciones/{operationId}?order_id=... según los schemas enlazados. Operación/Outbox se comprometen antes de 202; replay idéntico conserva identidad/resultado; contenido diferente genera conflicto. Restauración conserva consumption_operation_id y cancelled_at original.
3. Consulta candidata GET /api/v1/inventario/reservas/{reservaId}/estado?order_id=... y seguimiento durable G5 para expiración tardía: ACTIVA+VENCIDA y EXPIRADA, reinicio y carreras con pago/anulación. G5 conserva sus estados y decisiones del pedido. El trabajo Inventory en PR G6 #240 continúa separado y no acredita homologación.
4. Secuencia Marketplace con cupón: reserva creada → comprobar vigencia → cupón consumido → pago → consumo definitivo de stock. Reemplazos M1 conservan orden independiente sin cobro y consumo antes de despacho. Reintegro M2 continúa tras recepción física y aptitud, con location_id por entorno.
5. Cerrar parámetros candidatos: Retry-After 2 s, backoff con jitter hasta 30 s; deadline, frecuencia de conciliación y retención de operaciones/idempotencia por acordar. Definir responsables y ventana conjunta por SHA.

La candidata fuente tiene una discrepancia 400/409 para Idempotency-Key distinto del operation_id. Proponemos malformado/ausente → 400 VALIDACION; ambos UUID válidos pero diferentes → 409 IDEMPOTENCY_CONFLICT. Solicitaríamos ratificar/corregirlo antes del OpenAPI definitivo. OPERACION_CUPON_NO_ENCONTRADA sigue siendo código candidato. El tratamiento del tamaño máximo y de intenciones que no puedan enviarse también debe cerrarse antes de exponer las rutas.

## Respuesta solicitada

Por bloque: **ACEPTAMOS / PROPONEMOS CAMBIO**, campo/texto exacto, responsable M1/M2 y fecha propuesta para provider/consumer. No publicar tokens ni secretos. Aceptación documental, grants G7, integración y despliegue son evidencias independientes.

G6 prepara consumidores internos y componentes candidatos de admisión, consulta y entrega. Las tres rutas de cupones no se registran en Nest/Gateway hasta cerrar su contrato/seguridad; la evidencia autoritativa de reserva y snapshot sigue siendo una dependencia específica. El piloto Pricing/Audit #234/#235 no acredita esta integración. No se presupone RabbitMQ como fallback operativo.
