# Pruebas y evidencias H4 — G1 Marketplace

Este archivo especifica evidencia mínima, no afirma ejecución. Marcar `PASS` únicamente con log/evidencia, SHA exacto, operación, entorno y responsable. Separar fixtures contractuales, mocks, datos Supabase, Oracle desplegado, respuesta BFF y E2E real.

## Matriz mínima

| Caso | Owner/proveedor | Aserción mínima | Estado al corte |
|---|---|---|---|
| F-006 Inicio/categorías/destacados | Taxonomy + Catalog; composición G1 | `listarCategorias` y `listarProductos` se prueban por separado; `featuredProducts[]` es composición BFF G1, G6 no tiene curaduría editorial | PENDIENTE_PROVIDER_Y_BFF |
| Listado y búsqueda | Catalog | `listarProductos`, query MARKETPLACE, elegibilidad y vacío 200 | PENDIENTE_PROVIDER |
| Filtros | Catalog/Pricing | únicamente parámetros publicados; no filtrar página parcial global | BRECHA_CONTRACTUAL/PENDIENTE |
| Orden y paginación | Catalog + BFF G1 | enum mapeado, page 0→G6 1, page 1→G6 2, metadatos correctos | PENDIENTE_CONSUMER_PROVIDER |
| Detalle por slug | Catalog | elegible 200, inexistente/no elegible 404 sin motivo interno | PENDIENTE_PROVIDER |
| Producto simple | Catalog | `sku_base` vendible presente/usado según schema y reglas | PENDIENTE_PROVIDER |
| Producto variante | Catalog | `variant_id` distinto de `sku`; solo SKU elegibles, no inferencias | PENDIENTE_PROVIDER |
| Precio efectivo | Pricing | SKU autoritativo, canal, instante/vigencia, expirado y ausencia | PENDIENTE_PROVIDER |
| Disponibilidad 4 estados | Inventory/BFF | mapeo exhaustivo; `INDETERMINADO` HTTP 200 y no agotado/error | PENDIENTE_PROVIDER |
| Verificación N unidades | Inventory | `SUFICIENTE/INSUFICIENTE/INDETERMINADO`, `binding=false`, sin reserva | PENDIENTE_PROVIDER |
| Fulfillment ambiguo/ausente | G2/G5/Inventory | sin fuente única → indeterminado; contexto semántico inválido → 422 | PENDIENTE_OWNER_CONTEXT |
| Recomendaciones | Promotions/Catalog | Allowlist de operación enumera Marketplace/Chatbot/Retail; scope registry pending solo Chatbot. No inferir grant G7 ni padre con precio/stock ficticio. | PENDIENTE_ALINEACION_CONTRACTUAL_G7 |
| Promoción aplicable/no aplicable | Promotions | evaluación devuelve resultado sin mutar/consumir beneficio | PENDIENTE_HTTP_HANDLER |
| Cupón válido/inválido | Promotions | `validarCupon`, regla y error estable, no consumo | PENDIENTE_HTTP_HANDLER |
| Concurrencia carrito/deshacer | G1 + consultas G6 | versión/carrera manejada explícitamente y revalidación; no mutación silenciosa | PENDIENTE_G1_E2E |
| JWT correcto | G7/Gateway | token real firmado, `aud`, cliente, scope y allowlist correctos | PENDIENTE_GRANT_REAL |
| JWT sin scope / cliente incorrecto | G7/Gateway | denegación 403 con error contractual | PENDIENTE_SEGURIDAD |
| Expirado/firma inválida | Gateway | 401 contractual, sin fallback demo | PENDIENTE_SEGURIDAD |
| Timeout/error upstream/respuesta inválida | BFF G1/Gateway | timeout/5xx/esquema inválido se distingue de estado comercial; correlación | PENDIENTE_CONSUMER_PROVIDER |
| BFF G1 | G1 | llamada server-to-server, secreto solo servidor, mapeo DTO y códigos | PENDIENTE_INTEGRACION_REAL |
| Navegador real | G1 FE + BE + G6 | journey con BFF real, identidad/token real, datos identificados | PENDIENTE_E2E |
| F-019 Visualizar carrito | G1 + lecturas Catalog/Pricing/Inventory | Lectura comercial no cambia cantidades locales; estado/atención por línea | PENDIENTE_G1_E2E |
| F-020 Fusionar carrito anónimo | G1 + Catalog/Pricing/Inventory | Transacción/propietario/idempotencia G1; POST verificador G6 no vinculante, no produce máximo autorizado | PENDIENTE_G1_E2E |
| F-021 Mover ítem carrito a favoritos | G1 + Catalog | identidad elegible; transacción local; sin mutación de stock/promoción | PENDIENTE_G1_E2E |
| F-023 Cotización checkout | G1/G2/G5 + lecturas Catalog/Pricing/Inventory/Promotions según uso | G1 compone quote; G2 envío; G5 snapshot durable; no ruta quote G6 | PENDIENTE_G1_G2_G5 |
| F-024 Validar/aplicar cupón | G1/G6 Promotions/G5 | `evaluarPromociones` y `validarCupon` validan sin consumir; handlers HTTP pendientes de evidencia | PENDIENTE_HTTP_HANDLER |
| F-025 Preparar checkout/revalidar stock | G1 + Inventory/Pricing/Catalog/Promotions según uso | Cantidad N/contexto autoritativo; `SUFICIENTE` no reserva; no crear pedido ni pagar | PENDIENTE_G1_G6 |
| F-026 Crear pedido | G1/G5; G6 como dependencias indirectas | G5 `POST /api/v1/pedidos`; misma clave/payload retry; recuperar respuesta incierta según G5; `CREADO` != `PAGADO` | PENDIENTE_G1_G5 |
| F-036 Agregar favorito | G1 + Catalog | Persistencia G1 por identidad especificada; sin API Wishlist G6 | PENDIENTE_G1_E2E |
| F-037 Visualizar favoritos | G1 + Catalog/Pricing/Inventory según vista | Solo titular; validar identidad/elegibilidad y datos actuales cuando se presenten | PENDIENTE_G1_E2E |
| F-038 Quitar favorito/Deshacer | G1; validación G6 indirecta si restaura | Delete G1; revalidar al restaurar; sin API Wishlist G6 | PENDIENTE_G1_E2E |
| F-039 Mover favorito al carrito | G1 + Catalog/Pricing/Inventory según cantidad | No quitar favorito hasta operación G1 exitosa; verificación Inventory no vinculante | PENDIENTE_G1_E2E |
| Pedido/pago final | G1/G5 + G2 + dependencias G6 | Snapshot durable, idempotencia/fingerprint/correlación; `PAGADO` solo por G5 | PENDIENTE_E2E_G5 |
| Idempotencia de operación G6 | servicio owner | mismo key/payload no duplica efecto; key reutilizada con distinto fingerprint se rechaza según contrato | PENDIENTE_POR_OPERACION |

La matriz de operaciones separa las 25 funciones G1. La clasificación/evidencia no debe agrupar las filas F-019, F-020, F-021, F-023, F-024, F-025 o F-026 como una sola operación funcional. Para validar estructura, OpenAPI y enlaces desde la raíz Backend: `python scripts/validate_marketplace_h4_docs.py`.

## Ejecución reproducible requerida

Por cada fila ejecutada guardar: nombre del caso, comando/script, commit SHA de proveedor y consumidor, versión OpenAPI, ambiente, identidad/token sin secretos (ID/issuer y scopes efectivos), fixture o identificador de dataset, correlación, hora, resultado HTTP/schema, log de CI y enlace de artefacto. Los tokens se redactan. Registrar separado el estado de deploy con image digest y ambiente; no inferirlo del pipeline.

## Criterio de clasificación

- `CONTRATO_DEFINIDO`: operación y schema del OpenAPI identificados.
- `IMPLEMENTADO`: handler y camino al owner reconocidos en código del SHA indicado.
- `CI_VERIFICADA`: ejecución aprobada para el mismo SHA (workflow/run linked).
- `DESPLEGADO`: digest y ambiente confirmados.
- `AUTORIZACION_VERIFICADA`: token/grant real y pruebas positivas/negativas en el ambiente.
- `E2E_VERIFICADO`: BFF→Gateway→servicio→respuesta visible, con identidad y datos reales identificados.

Un PASS estático no convierte filas Provider/Consumer en PASS. Un mock no prueba proveedor real. HTTP 200 aislado no prueba readiness estable, autorización o E2E. Evaluación de cupón no consume y verificación de cantidades no reserva.
