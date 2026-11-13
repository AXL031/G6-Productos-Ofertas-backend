# Propuesta para el PR posterior de Docs

| Archivo de Docs | Cambio candidato |
| --- | --- |
| `contratos/http/openapi.yaml` | Incorporar los ocho paths y esquemas de [Catálogo](catalogo-admin.openapi.json), [Pricing](pricing-admin.openapi.json), [Inventario](inventory-admin.openapi.json), [Price Audit](price-audit-admin.openapi.json) y [Combos](combos-admin.openapi.json), reutilizando componentes oficiales de problema, correlación y userBearer donde sean equivalentes. Verificar que el diff de operaciones vigentes esté vacío. |
| `contratos/eventos/asyncapi.yaml` | Conservar los canales, versiones y mensajes de rc.4. Estas lecturas no publican eventos. |
| `arquitectura/Arquitectura.md` y `arquitectura/decisiones/MATRIZ-OPERACIONES-SEGURIDAD-G6.md` | Registrar `PROPUESTA_H4`: lecturas privadas de gestión en Catálogo, Pricing e Inventario, rol humano en ambos límites y CORS del Gateway como configuración de transporte. No agregarlas a la allowlist de lecturas públicas. |
| `requisitos/specs/SPEC-003-gestion-productos-crud.md` | Documentar relectura administrativa de borrador/inactivo, versión efectiva y semántica histórica de Q-06. |
| `requisitos/specs/SPEC-004-gestion-variantes-skus.md` | Vincular consultas existentes de variantes y preparación. Conservar la identidad de SKU vendible. |
| `requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md` | Documentar consulta de definición exacta y versión por canal. Mantener las reglas de herencia y los valores textuales de canal. |
| `requisitos/specs/SPEC-015-control-stock-disponibilidad.md` y `SPEC-016-dashboard-alertas-stock.md` | Documentar lectura de saldos físicos y metadatos de ubicación, umbral, estado local y ciclo de vida nullable. Mantener D-INV-01. |
| `integraciones/MATRIZ_INTERMODULAR_BACKEND.md` y acuerdos G1–G7 aplicables | Registrar que las rutas nuevas son para el gestor G6. Comparar OpenAPI y fixtures por consumidor; los permisos técnicos existentes se conservan. |
| `datos/catalog-svc/` | Documentar fuentes `products`, `product_images`, `product_attribute_values`, `sku_identity` y `sku_physical_profiles`. El cambio usa el modelo existente. |
| `contratos/pruebas/pruebas-contrato.md` | Agregar matriz de gestor, JWT inválido, actor M2M, estado/versión, filtros, 404 y relectura tras PATCH. Añadir caso separado de aislamiento comercial G1. |

**REQUIERE_HOMOLOGACION** en un bloque separado: homologar las rutas administrativas de Price Audit con DEC-G6-INT-06 para SKU y canal nulos. El DTO de rc.3 conserva su semántica. Los pendientes de los otros dominios están en [dependencias](DEPENDENCIAS_EXTERNAS_Y_OPERATIVAS.md).

- Revisar la migración candidata de recibos de Combos en apps/combos-svc/migrations/0002_create_combo_creation_receipts.sql. El rol runtime requiere SELECT e INSERT. Asociar en un mismo despliegue la migración y la ruta candidata. En una reversión, retirar primero la ruta y preservar los recibos mientras exista la posibilidad de replay.
- Registrar en SPEC-011 el almacenamiento de logos como integración H4 optativa y especificar el volumen y la URL de assets verificados. Los archivos se identifican por hash. La desvinculación de una marca no elimina un archivo que otra pueda referenciar.
- Documentar que SPEC-015 autoriza traslados por un mapa local de sujetos autenticados, independiente de claims de capacidad en el token G7. Gateway requiere habilitación explícita y conserva el cierre por defecto.
