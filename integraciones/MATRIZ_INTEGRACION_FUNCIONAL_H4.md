# Matriz central de integración funcional — Hito 4

Corte: 2026-10-20 (America/Lima). Issue: https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/114


## A. Fuentes y corte

| Repositorio | Referencia |
|---|---|
| Docs | [master c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/tree/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b) |
| Backend | [master 47e219e376fff1004ec10e9803c16119c811a699](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/tree/47e219e376fff1004ec10e9803c16119c811a699) |
| Frontend | [master 6e0448a40fb261abd7a3a5f7efdf1daeb517b55f](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/tree/6e0448a40fb261abd7a3a5f7efdf1daeb517b55f) |
| Estado Oracle | [actual](../ops/oracle/ESTADO_ACTUAL.md), [servicios](../ops/oracle/ESTADO_SERVICIOS.md), [dependencias](../ops/oracle/MATRIZ_DEPENDENCIAS.md), [RabbitMQ](../ops/oracle/RABBITMQ_COMPATIBILIDAD.md), [auditoría CI/CD](../ops/oracle/auditorias/2026-10-19_22-32-52_UTC/CICD.md) |

Corte documental 2026-10-20, objetivo Hito 4 2026-10-31. Oracle es evidencia de solo lectura del 19–20 oct y conserva el SHA/tag que observó. OpenAPI 0.6.0-rc.1 y AsyncAPI 0.6.0-rc.2 son candidatas; documentación no prueba homologación. No se toma una rama personal como implementación de master.

## B. Glosario e IDs

- Funcionalidad: capacidad de negocio con nombre y trazabilidad normativa.
- Mockup MK: representación visual; no es la funcionalidad, microservicio ni operación.
- Pantalla: vista MK-XXX-SXX; no acredita API.
- Módulo de negocio/bounded context: responsabilidad y datos propios, como Catalog o Pricing.
- Microservicio: proceso que implementa operaciones. Gateway es transversal.
- Operación API: operationId y ruta independiente del OpenAPI.
- Identidad funcional: el nombre oficial de cada funcionalidad según el [índice normativo](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/wireframes/INDEX.md). WF identifica un wireframe asociado; SPEC, HU, FLOW y MK identifican artefactos distintos y conservan sus códigos oficiales. No se inventan FUNC/FN.
- VERIFICADO = evidencia observable asociada a SHA/entorno/alcance; PARCIAL = solo una parte; PENDIENTE = sin evidencia suficiente; BLOQUEADO_ESPECÍFICO = solo frontera afectada espera resolución externa; NO_VERIFICADO = no hubo observación reproducible actual; NO_APLICA = contrato no lo exige, con fundamento.

## C. Resumen de las 16 funcionalidades

| Funcionalidad (nombre oficial) | Referencias WF / MK | Responsable · microservicio | SPEC / HU / FLOW | Estado |
|---|---|---|---|---|
| Carga y exportación masiva de productos | WF-001 · [MK-001](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-001/component-spec.md) S01–S05 | Marco Castilla · bulk-svc | [SPEC-001](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-001-carga-exportacion-masiva-productos.md) · [HU-001](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-001-carga-exportacion-masiva-productos.md) · [FLOW-001](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-001-carga-exportacion-masiva-productos.md) | Operaciones §D · estados §E |
| Gestión de combos de productos | WF-002 · [MK-002](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-002/component-spec.md) S01–S04 | Marco Castilla · combos-svc | [SPEC-002](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-002-gestion-combos-productos.md) · [HU-002](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-002-gestion-combos-productos.md) · [FLOW-002](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-002-gestion-combos-productos.md) | Operaciones §D · estados §E |
| Gestión de productos (CRUD principal) | WF-003 · [MK-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-003/component-spec.md); spec cruza MK-004-S01 | Gabriel Poma · catalog-svc | [SPEC-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-003-gestion-productos-crud.md) · [HU-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-003-gestion-productos-crud.md) · [FLOW-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-003-gestion-productos-crud.md) | Operaciones §D · estados §E |
| Gestión de variantes y SKU | WF-004 · [MK-004](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-004/component-spec.md); spec cruza MK-003-S04 | Gabriel Poma · catalog-svc | [SPEC-004](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-004-gestion-variantes-skus.md) · [HU-004](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-004-gestion-variantes-skus.md) · [FLOW-004](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-004-gestion-variantes-skus.md) | Operaciones §D · estados §E |
| Gestión de cupones de descuento | WF-005 · [MK-005](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-005/component-spec.md) S01–S06 | Axel Cueva · promotions-svc | [SPEC-005](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-005-gestion-cupones-descuento.md) · [HU-005](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-005-gestion-cupones-descuento.md) · [FLOW-005](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-005-gestion-cupones-descuento.md) | Operaciones §D · estados §E |
| Gestión de ofertas y promociones | WF-006 · [MK-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-006/component-spec.md) S01–S06 | Axel Cueva · promotions-svc | [SPEC-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-006-gestion-ofertas-promociones.md) · [HU-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-006-gestion-ofertas-promociones.md) · [FLOW-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-006-gestion-ofertas-promociones.md) | Operaciones §D · estados §E |
| Reglas de venta cruzada y upselling | WF-007 · [MK-007](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-007/component-spec.md) S01–S07 | Axel Cueva · promotions-svc | [SPEC-007](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-007-reglas-venta-cruzada-upselling.md) · [HU-007](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-007-reglas-venta-cruzada-upselling.md) · [FLOW-007](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-007-reglas-venta-cruzada-upselling.md) | Operaciones §D · estados §E |
| Gestión de categorías y subcategorías | WF-008 · [MK-008](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-008/component-spec.md) S01–S05 | Leonardo López · taxonomy-svc | [SPEC-008](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-008-gestion-categorias.md) · [HU-008](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-008-gestion-categorias.md) · [FLOW-008](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-008-gestion-categorias.md) | Operaciones §D · estados §E |
| Gestión de características y valores | WF-009 · [MK-009](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-009/component-spec.md) S01–S06 | Leonardo López · taxonomy-svc | [SPEC-009](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-009-gestion-caracteristicas.md) · [HU-009](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-009-gestion-caracteristicas.md) · [FLOW-009](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-009-gestion-caracteristicas.md) | Operaciones §D · estados §E |
| Asociación entre tipos de producto y características | WF-010 · [MK-010](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-010/component-spec.md) S01–S05 | Leonardo López · taxonomy-svc | [SPEC-010](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-010-asociacion-tipo-producto-caracteristica.md) · [HU-010](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-010-asociacion-tipo-producto-caracteristica.md) · [FLOW-010](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-010-asociacion-tipo-producto-caracteristica.md) | Operaciones §D · estados §E |
| Gestión de marcas | WF-011 · [MK-011](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-011/component-spec.md) S01–S05 | Leonardo López · taxonomy-svc | [SPEC-011](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-011-gestion-marcas.md) · [HU-011](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-011-gestion-marcas.md) · [FLOW-011](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-011-gestion-marcas.md) | Operaciones §D · estados §E |
| Gestión de SEO y metadatos | WF-012 · [MK-012](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-012/component-spec.md) S01–S03 | Leonardo López · taxonomy-svc | [SPEC-012](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-012-seo-metadatos.md) · [HU-012](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-012-seo-metadatos.md) · [FLOW-012](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-012-seo-metadatos.md) | Operaciones §D · estados §E |
| Gestión de precios individuales y masivos | WF-013 · [MK-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-013/component-spec.md) S01–S06 | Leonardo Vera · pricing-svc | [SPEC-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md) · [HU-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-013-gestion-precios-individuales-masivos.md) · [FLOW-013](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-013-gestion-precios-individuales-masivos.md) | Operaciones §D · estados §E |
| Historial de auditoría de precios | WF-014 · [MK-014](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-014/component-spec.md) S01–S05 | Leonardo Vera · price-audit-svc | [SPEC-014](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-014-historial-auditoria-precios.md) · [HU-014](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-014-historial-auditoria-precios.md) · [FLOW-014](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-014-historial-auditoria-precios.md) | Operaciones §D · estados §E |
| Control de stock y disponibilidad | WF-015 · [MK-015](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-015/component-spec.md) sin pantallas MK-015-SXX identificables | Miguel Taco · inventory-svc | [SPEC-015](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-015-control-stock-disponibilidad.md) · [HU-015](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-015-control-stock-disponibilidad.md) · [FLOW-015](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-015-control-stock-disponibilidad.md) | Operaciones §D · estados §E |
| Dashboard analítico y alertas de stock | WF-016 · [MK-016](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-016/component-spec.md) incluye pantallas MK-015-S01/S03–S05 | Miguel Taco · inventory-svc | [SPEC-016](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-016-dashboard-alertas-stock.md) · [HU-016](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/hu/HU-016-dashboard-alertas-stock.md) · [FLOW-016](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/flujos/FLOW-016-dashboard-alertas-stock.md) | Operaciones §D · estados §E |





## D. Operaciones HTTP (contrato vs master)

Contrato: [OpenAPI fijado al corte](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/contratos/http/openapi.yaml) `0.6.0-rc.1`. Cada línea representa `operationId`, método y ruta. El resumen de 16 funcionalidades no equivale a la cobertura total del contrato. Salvo indicación, no hay controller de negocio en Backend master.

### Carga y exportación masiva de productos

Referencia documental: `WF-001` (wireframe)
- descargarPlantillaProductos — GET /api/v1/carga-masiva/productos/plantilla — pendiente
- crearImportacionGeneralProductos — POST /api/v1/carga-masiva/productos/importaciones — pendiente
- obtenerImportacionGeneralProductos — GET /api/v1/carga-masiva/productos/importaciones/{batchId} — pendiente
- descargarReporteImportacionGeneral — GET /api/v1/carga-masiva/productos/importaciones/{batchId}/reporte — pendiente
- reanudarImportacionGeneral — POST /api/v1/carga-masiva/productos/importaciones/{batchId}/reanudar — pendiente
- crearExportacionGeneralProductos — POST /api/v1/carga-masiva/productos/exportaciones — pendiente
- obtenerExportacionGeneralProductos — GET /api/v1/carga-masiva/productos/exportaciones/{exportId} — pendiente
- descargarExportacionGeneralProductos — GET /api/v1/carga-masiva/productos/exportaciones/{exportId}/archivo — pendiente

### Gestión de combos de productos

Referencia documental: `WF-002` (wireframe)
- listarCombosAdmin — GET /api/v1/combos — pendiente
- crearCombo — POST /api/v1/combos — pendiente
- obtenerCombo — GET /api/v1/combos/{comboId} — pendiente
- actualizarCombo — PATCH /api/v1/combos/{comboId} — pendiente
- desactivarCombo — POST /api/v1/combos/{comboId}/desactivar — pendiente
- consultarDisponibilidadCombo — GET /api/v1/combos/{comboId}/disponibilidad — pendiente

### Gestión de productos

Referencia documental: `WF-003` (wireframe)
- listarProductos — GET /api/v1/productos — controller master; Oracle 20-oct 200 con 15 items en tag 9205eb455c4965a82ccb9fc4714cf976e4c059b0, distinto de master actual.
- crearProducto — POST /api/v1/productos — pendiente
- obtenerProducto — GET /api/v1/productos/{productoId} — pendiente
- actualizarProducto — PATCH /api/v1/productos/{productoId} — pendiente
- activarProducto — POST /api/v1/productos/{productoId}/activar — pendiente
- desactivarProducto — POST /api/v1/productos/{productoId}/desactivar — pendiente
- reactivarProducto — POST /api/v1/productos/{productoId}/reactivar — pendiente
- obtenerProductoPorSlug — GET /api/v1/productos/por-slug/{slug} — controller master; Oracle detalle 200 en tag previo, no master actual.
- obtenerPreparacionProducto — GET /api/v1/productos/{productoId}/preparacion — pendiente
- reintentarPreparacionProducto — POST /api/v1/productos/{productoId}/preparacion/reintentar — pendiente

### Gestión de variantes y SKU

Referencia documental: `WF-004` (wireframe)
- listarVariantesProducto — GET /api/v1/productos/{productoId}/variantes — pendiente
- crearVariante — POST /api/v1/productos/{productoId}/variantes — pendiente
- obtenerVariante — GET /api/v1/productos/{productoId}/variantes/{variantId} — pendiente
- actualizarVariante — PATCH /api/v1/productos/{productoId}/variantes/{variantId} — pendiente
- activarVariante — POST /api/v1/productos/{productoId}/variantes/{variantId}/activar — pendiente
- desactivarVariante — POST /api/v1/productos/{productoId}/variantes/{variantId}/desactivar — pendiente
- reactivarVariante — POST /api/v1/productos/{productoId}/variantes/{variantId}/reactivar — pendiente
- reintentarPreparacionVariante — POST /api/v1/productos/{productoId}/variantes/{variantId}/preparacion/reintentar — pendiente
- resolverCodigoBarras — POST /api/v1/productos/codigos-barras/resolver — pendiente

### Gestión de cupones de descuento

Referencia documental: `WF-005` (wireframe)
- listarCupones — GET /api/v1/cupones — pendiente
- crearCupon — POST /api/v1/cupones — pendiente
- obtenerCuponAdmin — GET /api/v1/cupones/{cuponId} — pendiente
- actualizarCupon — PATCH /api/v1/cupones/{cuponId} — pendiente
- activarCupon — POST /api/v1/cupones/{cuponId}/activar — pendiente
- desactivarCupon — POST /api/v1/cupones/{cuponId}/desactivar — pendiente
- validarCupon — POST /api/v1/cupones/validar — pendiente; validar no consume

### Gestión de ofertas y promociones

Referencia documental: `WF-006` (wireframe)

- listarPromocionesAdmin — GET /api/v1/promociones/administracion — OpenAPI provisional-internal, source SPEC-006; no implementada en Backend master: el controller [promotions-svc](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/promotions-svc/src/promotions-svc.controller.ts) solo expone health en ese SHA.
- listarPromociones — GET /api/v1/promociones — pendiente
- crearPromocion — POST /api/v1/promociones — pendiente
- obtenerPromocionAdmin — GET /api/v1/promociones/{promocionId} — pendiente
- actualizarPromocion — PATCH /api/v1/promociones/{promocionId} — pendiente
- activarPromocion — POST /api/v1/promociones/{promocionId}/activar — pendiente
- desactivarPromocion — POST /api/v1/promociones/{promocionId}/desactivar — pendiente
- evaluarPromociones — POST /api/v1/promociones/evaluar — pendiente; no consume cupón

### Reglas de venta cruzada y upselling

Referencia documental: `WF-007` (wireframe)
- obtenerRecomendaciones — GET /api/v1/recomendaciones — pendiente
- listarReglasRecomendacion — GET /api/v1/recomendaciones/reglas — pendiente
- crearReglaRecomendacion — POST /api/v1/recomendaciones/reglas — pendiente
- obtenerReglaRecomendacion — GET /api/v1/recomendaciones/reglas/{reglaId} — pendiente
- actualizarReglaRecomendacion — PATCH /api/v1/recomendaciones/reglas/{reglaId} — pendiente
- activarReglaRecomendacion — POST /api/v1/recomendaciones/reglas/{reglaId}/activar — pendiente
- desactivarReglaRecomendacion — POST /api/v1/recomendaciones/reglas/{reglaId}/desactivar — pendiente

### Gestión de categorías y subcategorías

Referencia documental: `WF-008` (wireframe)
- listarCategorias — GET /api/v1/categorias — controller master; Oracle observó lectura por Gateway.
- obtenerArbolCategoriasAdmin — GET /api/v1/categorias/arbol — pendiente
- crearCategoria — POST /api/v1/categorias — pendiente
- obtenerCategoriaAdmin — GET /api/v1/categorias/{categoriaId} — pendiente
- actualizarCategoria — PATCH /api/v1/categorias/{categoriaId} — pendiente
- solicitarDesactivacionCategoria — POST /api/v1/categorias/{categoriaId}/desactivar — pendiente
- reactivarCategoria — POST /api/v1/categorias/{categoriaId}/reactivar — pendiente
- listarCategoriasAdmin — GET /api/v1/categorias/administracion — pendiente

### Gestión de características y valores

Referencia documental: `WF-009` (wireframe)
- listarCaracteristicas — GET /api/v1/caracteristicas — pendiente
- crearCaracteristica — POST /api/v1/caracteristicas — pendiente
- obtenerCaracteristica — GET /api/v1/caracteristicas/{caracteristicaId} — pendiente
- actualizarCaracteristica — PATCH /api/v1/caracteristicas/{caracteristicaId} — pendiente
- listarValoresCaracteristica — GET /api/v1/caracteristicas/{caracteristicaId}/valores — pendiente
- crearValorCaracteristica — POST /api/v1/caracteristicas/{caracteristicaId}/valores — pendiente
- actualizarValorCaracteristica — PATCH /api/v1/caracteristicas/{caracteristicaId}/valores/{valorId} — pendiente
- solicitarDesactivacionValorCaracteristica — POST /api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}/desactivar — pendiente
- reactivarValorCaracteristica — POST /api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}/reactivar — pendiente
- desactivarCaracteristica — POST /api/v1/caracteristicas/{caracteristicaId}/desactivar — pendiente
- reactivarCaracteristica — POST /api/v1/caracteristicas/{caracteristicaId}/reactivar — pendiente

### Asociación entre tipos de producto y características

Referencia documental: `WF-010` (wireframe)
- listarTiposProducto — GET /api/v1/tipos-producto — pendiente
- crearTipoProducto — POST /api/v1/tipos-producto — pendiente
- obtenerTipoProducto — GET /api/v1/tipos-producto/{tipoProductoId} — pendiente
- solicitarDesactivacionTipoProducto — POST /api/v1/tipos-producto/{tipoProductoId}/desactivar — pendiente
- reactivarTipoProducto — POST /api/v1/tipos-producto/{tipoProductoId}/reactivar — pendiente
- obtenerEsquemaTipoProducto — GET /api/v1/tipos-producto/{tipoProductoId}/caracteristicas — pendiente
- asociarCaracteristicaTipoProducto — POST /api/v1/tipos-producto/{tipoProductoId}/caracteristicas — pendiente
- actualizarAsociacionTipoCaracteristica — PATCH /api/v1/tipos-producto/{tipoProductoId}/caracteristicas/{caracteristicaId} — pendiente
- solicitarDesasociacionTipoCaracteristica — POST /api/v1/tipos-producto/{tipoProductoId}/caracteristicas/{caracteristicaId}/desasociar — pendiente

### Gestión de marcas

Referencia documental: `WF-011` (wireframe)
- listarMarcas — GET /api/v1/marcas — controller master; Oracle no probó esta operación.
- crearMarca — POST /api/v1/marcas — pendiente
- obtenerMarcaAdmin — GET /api/v1/marcas/{marcaId} — pendiente
- actualizarMarca — PATCH /api/v1/marcas/{marcaId} — pendiente
- solicitarDesactivacionMarca — POST /api/v1/marcas/{marcaId}/desactivar — pendiente
- reactivarMarca — POST /api/v1/marcas/{marcaId}/reactivar — pendiente
- listarMarcasAdmin — GET /api/v1/marcas/administracion — pendiente

### Gestión de SEO y metadatos

Referencia documental: `WF-012` (wireframe)
- resolverSlugCategoriaCreacion — POST /api/v1/seo/categorias/slug/resolver — pendiente; propone slug, no crea categoría.
- obtenerSeoPorSlug — GET /api/v1/seo/{slug} — pendiente
- resolverSlugAnterior — GET /api/v1/seo/resoluciones/{slugAnterior} — pendiente
- obtenerSeoCategoriaAdmin — GET /api/v1/categorias/{categoriaId}/seo — pendiente
- actualizarSeoCategoria — PATCH /api/v1/categorias/{categoriaId}/seo — pendiente
- listarHistorialSlugCategoria — GET /api/v1/categorias/{categoriaId}/seo/historial — pendiente
- obtenerOperacionMaestra — GET /api/v1/taxonomia/operaciones/{operationId} — pendiente; no sustituye operación funcional

### Gestión de precios individuales y masivos

Referencia documental: `WF-013` (wireframe)
- consultarPrecios — GET /api/v1/precios — consulta comercial pendiente.
- obtenerPrecioSku — GET /api/v1/precios/skus/{sku} — pendiente; #24 bloquea contexto SKU.
- actualizarPrecioSku — PATCH /api/v1/precios/skus/{sku} — pendiente
- listarProgramacionesPrecioSku — GET /api/v1/precios/skus/{sku}/programaciones — controller master
- programarPrecioSku — POST /api/v1/precios/skus/{sku}/programaciones — pendiente
- obtenerPrecioBaseProducto — GET /api/v1/precios/productos/{productoId} — controller master, no precio efectivo SKU/canal
- actualizarPrecioBaseProducto — PATCH /api/v1/precios/productos/{productoId} — pendiente
- listarProgramacionesPrecioProducto — GET /api/v1/precios/productos/{productoId}/programaciones — controller master
- programarPrecioBaseProducto — POST /api/v1/precios/productos/{productoId}/programaciones — pendiente
- prevalidarImportacionPrecios — POST /api/v1/precios/importaciones/prevalidar — pendiente
- crearImportacionPrecios — POST /api/v1/precios/importaciones — pendiente
- obtenerImportacionPrecios — GET /api/v1/precios/importaciones/{batchId} — controller master, sin E2E
- descargarReporteImportacionPrecios — GET /api/v1/precios/importaciones/{batchId}/reporte — pendiente

### Historial y auditoría de precios

Referencia documental: `WF-014` (wireframe)
- listarAuditoriaPrecios — GET /api/v1/auditoria-precios — pendiente
- obtenerAuditoriaPrecio — GET /api/v1/auditoria-precios/{auditId} — pendiente
- crearExportacionAuditoriaPrecios — POST /api/v1/auditoria-precios/exportaciones — pendiente
- obtenerExportacionAuditoriaPrecios — GET /api/v1/auditoria-precios/exportaciones/{exportId} — pendiente
- descargarExportacionAuditoriaPrecios — GET /api/v1/auditoria-precios/exportaciones/{exportId}/archivo — pendiente

### Control de stock y disponibilidad

Referencia documental: `WF-015` (wireframe)
- consultarDisponibilidad — GET /api/v1/inventario/disponibilidad — pendiente
- solicitarReserva — POST /api/v1/inventario/reservas — pendiente
- confirmarReserva — POST /api/v1/inventario/reservas/{reservaId}/confirmar — pendiente
- liberarReserva — POST /api/v1/inventario/reservas/{reservaId}/liberar — pendiente
- consultarDisponibilidadComercial — GET /api/v1/inventario/disponibilidad/comercial — pendiente
- verificarCantidadComercial — POST /api/v1/inventario/disponibilidad/comercial/verificar — pendiente; no reserva
- consultarOperacionInventario — GET /api/v1/inventario/operaciones/{operationId} — pendiente
- obtenerUmbralesInventario — GET /api/v1/inventario/umbrales — pendiente
- actualizarUmbralGlobal — PUT /api/v1/inventario/umbrales/global — pendiente
- establecerUmbralSku — PUT /api/v1/inventario/umbrales/skus/{sku} — pendiente
- eliminarUmbralSku — DELETE /api/v1/inventario/umbrales/skus/{sku} — pendiente
- reportarIncidenciaInventario — POST /api/v1/inventario/incidencias — pendiente
- resolverIncidenciaInventario — POST /api/v1/inventario/incidencias/{incidenciaId}/resolver — pendiente
- reintegrarInventario — POST /api/v1/inventario/reintegros — pendiente
- conciliarVentaOffline — POST /api/v1/inventario/conciliaciones-offline — pendiente; invocador/DTO contradichos en fuentes
- listarTrasladosInventario — GET /api/v1/inventario/traslados — pendiente
- obtenerTrasladoInventario — GET /api/v1/inventario/traslados/{trasladoId} — pendiente
- registrarRecepcionTrasladoInventario — POST /api/v1/inventario/traslados/{trasladoId}/recepciones — pendiente

### Dashboard analítico y alertas de stock

Referencia documental: `WF-016` (wireframe)
- obtenerDashboardInventario — GET /api/v1/inventario/dashboard — pendiente
- obtenerUmbralesInventario — GET /api/v1/inventario/umbrales — pendiente; compartida como trazabilidad en WF-015, no API duplicada
- actualizarUmbralGlobal — PUT /api/v1/inventario/umbrales/global — pendiente
- establecerUmbralSku — PUT /api/v1/inventario/umbrales/skus/{sku} — pendiente
- eliminarUmbralSku — DELETE /api/v1/inventario/umbrales/skus/{sku} — pendiente
- listarTrasladosInventario — GET /api/v1/inventario/traslados — pendiente
- obtenerTrasladoInventario — GET /api/v1/inventario/traslados/{trasladoId} — pendiente

El resumen de AsyncAPI por feature: Bulk coordina solicitudes de Catalog/Pricing/Inventory; Catalog inicia precio/stock y emite bajas; Promociones solicita consumo/restauración; Taxonomy publica cambios de categoría/tipo/valor; Pricing publica price.changed; Price Audit lo consume; Inventory publica estado/reserva/consumo. Son contratos, no productores o consumidores observados. Broker de Oracle reporta cero conexiones y consumers. Bloqueo AMQP no bloquea HTTP/DB independiente.




**Código backend revisado en el SHA master del corte:** [Catalog commercial.controller.ts](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/catalog-svc/src/commercial.controller.ts), [Taxonomy taxonomy.controller.ts](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/taxonomy-svc/src/taxonomy.controller.ts), [Pricing pricing-read.controller.ts](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/pricing-svc/src/http/pricing-read.controller.ts), y controladores scaffold [Bulk](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/bulk-svc/src/bulk-svc.controller.ts), [Combos](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/combos-svc/src/combos-svc.controller.ts), [Promotions](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/promotions-svc/src/promotions-svc.controller.ts), [Inventory](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/inventory-svc/src/inventory-svc.controller.ts), [Price Audit](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/price-audit-svc/src/price-audit-svc.controller.ts).<br>
**Modelos de persistencia por owner:** [bulk](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/bulk/physical-model.md), [combos](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/combos/physical-model.md), [catalog](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/catalog-svc/physical-model.md), [promotions](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/promotions/physical-model.md), [taxonomy](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/taxonomy/physical-model.md), [pricing](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/pricing/physical-model.md), [price_audit](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/price_audit/physical-model.md), [inventory](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/datos/inventory-svc/physical-model.md). Modelo o migración no equivale a persistencia runtime por operación.
### Operación transversal de soporte a SKU (no constituye una funcionalidad 17)

- consultarDatosFisicos — POST /api/v1/productos/datos-fisicos/consulta — operación provisional de consulta física asociada al SKU; Catálogo es owner G6 del perfil físico de producto simple y cada variante mantiene su propio peso/dimensiones ([SPEC-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-003-gestion-productos-crud.md), [SPEC-004](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/requisitos/specs/SPEC-004-gestion-variantes-skus.md)). Despacho/G2 es el consumidor indicado por `x-source-external`; el contrato no acredita homologación. En Backend master SHA `47e219e`, el Gateway registra la ruta, pero eso no demuestra handler de Catálogo ni ejecución de la operación: [tabla de rutas](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/api-gateway/src/routing/contract-routes.ts). En Backend master SHA `47e219e`, el controller comercial de Catálogo tampoco registra esta ruta ([commercial.controller.ts](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/47e219e376fff1004ec10e9803c16119c811a699/apps/catalog-svc/src/commercial.controller.ts)). Estado de implementación: PENDIENTE/NO_VERIFICADO en runtime.

## E. Estados independientes por funcionalidad

El resumen conserva 16 funcionalidades en formato compacto. Por funcionalidad se separan implementación backend, frontend/Gateway, persistencia, AMQP, autenticación/autorización, CI, despliegue, E2E y homologación. `PENDIENTE` indica evidencia insuficiente al corte, no necesariamente una falla. La CI documental no prueba runtime de cada operación.

### Carga y exportación masiva de productos

Referencia funcional: `WF-001` (wireframe) · issues de implementación backend: #88–94.

- Backend: Solo health scaffold; 8 ops sin handlers. Schema bulk documentado, sin persistencia funcional master.
- Frontend / Gateway: MOCK; [FE #34](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/34)
- Persistencia: Schema descrito; persistencia funcional en master no demostrada.
- AMQP: Eventos bulk contractuales; sin conexión/consumer real.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de combos de productos

Referencia funcional: `WF-002` (wireframe) · issues de implementación backend: #79–87.

- Backend: Solo health; 6 ops sin handlers. Schema documentado, persistencia real no demostrada.
- Frontend / Gateway: MOCK; FE #34; PR FE #28 abierto
- Persistencia: Schema descrito; persistencia funcional en master no demostrada.
- AMQP: Sin evento propio Combo; consumer no verificado.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de productos (CRUD principal)

Referencia funcional: `WF-003` (wireframe) · issues de implementación backend: #43–51.

- Backend: Solo listarProductos y obtenerProductoPorSlug en controller master. Schema/repos presentes; Oracle respondió con tag previo 9205…, no SHA actual.
- Frontend / Gateway: MOCK; [FE #35](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/35), PR #40 abierto/CI fallida
- Persistencia: Schema/repositorios presentes; persistencia runtime en master no demostrada.
- AMQP: Preparación/baja contractuales; no producer/consumer probado.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de variantes y SKU

Referencia funcional: `WF-004` (wireframe) · issues de implementación backend: #43–51.

- Backend: Variantes sin controller master, DB runtime no demostrada.
- Frontend / Gateway: MOCK; FE #35
- Persistencia: Persistencia runtime NO_VERIFICADA.
- AMQP: Eventos SKU contractuales, no reales.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de cupones de descuento

Referencia funcional: `WF-005` (wireframe) · issues de implementación backend: #70–78.

- Backend: Solo health; CRUD/validación ausentes. Migración no prueba handler.
- Frontend / Gateway: MOCK; [FE #36](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/36), PR #41 no merge/CI fallida
- Persistencia: Migración mencionada; persistencia funcional/runtime no demostrada.
- AMQP: Consumo/restauración contractuales; broker sin conexiones/consumers, nombres incompatibles.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de ofertas y promociones

Referencia funcional: `WF-006` (wireframe) · issues de implementación backend: #70–78.

- Backend: Sin handlers comerciales master, persistencia funcional pendiente.
- Frontend / Gateway: MOCK; FE #36
- Persistencia: PENDIENTE; evidencia runtime no presentada.
- AMQP: Proyecciones contractuales, no runtime.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Reglas de venta cruzada y upselling

Referencia funcional: `WF-007` (wireframe) · issues de implementación backend: #70–78.

- Backend: Recomendaciones/CRUD sin handler master.
- Frontend / Gateway: MOCK; FE #36
- Persistencia: PENDIENTE/NO_VERIFICADO; detalle funcional en el estado Backend.
- AMQP: Proyecciones contractuales, sin consumers.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de categorías y subcategorías

Referencia funcional: `WF-008` (wireframe) · issues de implementación backend: #34–42.

- Backend: GET categorías master; Oracle comprobó lectura vía Gateway en tag anterior. CRUD/árbol pendientes. Schema taxonomy; readiness en tag anterior.
- Frontend / Gateway: MOCK; [FE #37](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/37), PR #41 sin merge
- Persistencia: Schema descrito; runtime no verificado con SHA/entorno actual.
- AMQP: Cambio/baja segura contractuales; consumer no verificado.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de características y valores

Referencia funcional: `WF-009` (wireframe) · issues de implementación backend: #34–42.

- Backend: Sin rutas comerciales en controller master.
- Frontend / Gateway: MOCK; FE #37
- Persistencia: PENDIENTE/NO_VERIFICADO; detalle funcional en el estado Backend.
- AMQP: characteristic-value.updated contractual, no runtime.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Asociación entre tipos de producto y características

Referencia funcional: `WF-010` (wireframe) · issues de implementación backend: #34–42.

- Backend: Asociación sin controller master.
- Frontend / Gateway: MOCK; FE #37
- Persistencia: PENDIENTE/NO_VERIFICADO; detalle funcional en el estado Backend.
- AMQP: product-type-schema.changed contractual, no publisher/consumer.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de marcas

Referencia funcional: `WF-011` (wireframe) · issues de implementación backend: #34–42.

- Backend: GET marcas en master; alta/edición/estado pendiente, no probado en Oracle.
- Frontend / Gateway: MOCK; FE #37
- Persistencia: PENDIENTE/NO_VERIFICADO; detalle funcional en el estado Backend.
- AMQP: Baja segura contractual; consumer no evidenciado.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de SEO y metadatos

Referencia funcional: `WF-012` (wireframe) · issues de implementación backend: #34–42.

- Backend: SEO/slug/historial sin controller master.
- Frontend / Gateway: MOCK; FE #37
- Persistencia: PENDIENTE/NO_VERIFICADO; detalle funcional en el estado Backend.
- AMQP: Sin evento específico atribuible.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Gestión de precios individuales y masivos

Referencia funcional: `WF-013` (wireframe) · issues de implementación backend: #24/#55–60.

- Backend: Cuatro GET administrativos master; consultas comerciales, writes/importación parciales. Schema pricing; Outbox parcial [Backend PR #127](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/127).
- Frontend / Gateway: UI mock; [FE PR #47](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/pull/47) abierto, head `f99fb6eeb45a67c34aee4368b53363952716a258`; adaptador candidato sin React→Gateway; [FE #38](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/38), #45 pendiente
- Persistencia: Schema descrito; Outbox parcial no acredita persistencia completa.
- AMQP: price.changed/bulk/init contractuales; relay/publicación no acreditados.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: Oracle observó readiness; no se acredita despliegue de SHA funcional actual.
- E2E: PENDIENTE; readiness no equivale a E2E.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Historial de auditoría de precios

Referencia funcional: `WF-014` (wireframe) · issues de implementación backend: #61–69.

- Backend: Solo health; sin API/audit append-only master.
- Frontend / Gateway: MOCK explícito; FE #38
- Persistencia: PENDIENTE/NO_VERIFICADO; detalle funcional en el estado Backend.
- AMQP: Consumer price.changed no verificado; broker sin conexiones.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Control de stock y disponibilidad

Referencia funcional: `WF-015` (wireframe) · issues de implementación backend: #97–105.

- Backend: Solo health master; APIs sin handler. Modelo/migraciones Docs no prueban DB runtime.
- Frontend / Gateway: MOCK; [FE #39](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/39)
- Persistencia: Persistencia runtime NO_VERIFICADA.
- AMQP: Contractual; sin conexión real.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### Dashboard analítico y alertas de stock

Referencia funcional: `WF-016` (wireframe) · issues de implementación backend: #97–105.

- Backend: Dashboard/umbrales sin controller ni DB runtime.
- Frontend / Gateway: MOCK; FE #39
- Persistencia: Persistencia runtime NO_VERIFICADA.
- AMQP: stock.changed contractual; consumer no verificado.
- Autenticación / autorización: 401/403 NO_VERIFICADO por operación; ver limitación consignada en la fuente de estado.
- CI del código de negocio en master: NO_VERIFICADO por operación; los runs del SHA documental se detallan en §E, subsección «CI del SHA documental auditado y evidencia anterior».
- Despliegue: PENDIENTE/NO_VERIFICADO para SHA de master citado.
- E2E: PENDIENTE; no se aporta resultado reproducible con SHAs y entorno.
- Homologación externa: PENDIENTE/NO_VERIFICADO para los límites intermodulares aplicables (§F); la lógica interna G6 no requiere homologación externa.

### CI del SHA documental auditado y evidencia anterior

El HEAD auditado `999850619fa7a48cc225b27fcd161ffcf885bd8e` coincide con [run 39535334327 (push)](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39535334327) y [run 39535340206 (pull_request)](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39535340206), ambos SUCCESS/completed. Estos runs validan el commit documental auditado. No prueban despliegue Oracle, autorización E2E ni implementación de las 16 funcionalidades.

Como evidencia anterior, el SHA `74e69b2c912592fac38f612aa0bc179a7b2b8f2c` coincide con [run 39532444119 (pull_request)](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39532444119) y [run 39532438601 (push)](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/39532438601), ambos SUCCESS/completed. Los jobs de lint, typecheck, tests, build, smoke, validación documental y Taxonomy finalizaron correctamente en ese SHA anterior; esta evidencia no valida `9998506` ni commits posteriores. La CI de un commit documental valida ese commit, no la implementación ni el despliegue de las 16 funcionalidades.

## F. Seguridad, evidencias transversales y bloqueos

OpenAPI define por operación bearer, scopes y respuestas 401/403. No se inventan issuer, claims, roles o grants de G7. Backend #21 informa Gateway con readiness/cobertura parcial; PR #134 habilita un bypass de demo acotado a GET aprobados, no autenticación general. Oracle observó 200 sin auth para lecturas de demo Catalog/categorías y 401 en otros grupos; eso no sustituye pruebas 401/403 por operación. Frontend #45 mantiene pendientes cliente común, sesión/JWT y composición API. En modo API no se permite fallback silencioso a mock.

| Estado | Owner | Frontera afectada | Condición objetiva de desbloqueo |
|---|---|---|---|
| BLOQUEADO_ESPECÍFICO Catalog→Pricing | Poma + Vera; Marco coordina | Precio que requiere contexto SKU (#24/#55–60), no pruebas internas con fixtures. | Contrato/acuerdo Catalog verificable y pruebas por SHA de SKU/variante elegible e inválida. |
| BLOQUEADO_ESPECÍFICO UI→Gateway/JWT | Marco/Gateway; G7 solo por dato externo faltante | Solo rutas cuya integración dependa de ruta o grant no definido. | Rutas OpenAPI y pruebas 200/401/403 por scope; G7 registra issuer/JWKS/claims faltantes. |
| BLOQUEADO_ESPECÍFICO AMQP Oracle | Marco/owner contrato + owners servicio + consumer externo | Publicación/consumo productivo: nombres exchange/queue/ACL/red difieren de lo observado; retry/DLX ausentes. | Aprobar nombres, routing, payload, red, ACL y versión; verificar conexión/permisos mínimos aislados antes del release. HTTP/DB independiente continúa. |
| BLOQUEADO_ESPECÍFICO homologación | Owners G1/G3/G4/G5 concernidos y G6 | Contrato/secuencia compartidos solamente. | Aceptación externa explícita de operación/versión y prueba bilateral; 2xx no homologa. |
| PENDIENTE deploy/E2E | Marco + owners de servicios | Promoción y recorrido de usuario. | Gate individual #111 con SHA/imagen, CI exacta, readiness, smoke y recuperación; E2E añade SHAs Frontend/Gateway/servicio y entorno. |

Los PRs #121/#127/#128/#132 son merges parciales; FE #47 permanece abierto. CI run 39036724209 corresponde al candidato FE #47. El status API consultado no devolvió checks asociados al SHA master backend del corte, por tanto CI exacta de master = NO_VERIFICADO. Oracle muestra imágenes de SHA previos y cinco servicios ausentes. No se ejecutó build, E2E ni deploy en esta auditoría documental.

## G. Brechas P0 Hito 4

1. **Demo:** no hay recorrido autenticado pantalla→operación para las 16 funciones. Solo algunas lecturas demo observadas; resto mock o sin handler.
2. **CI/CD:** Oracle registra ausentes Price Audit, Promotions, Inventory, Combos y Bulk; readiness Gateway parcial/inestable. CI de candidatos no es CI del SHA integrado/desplegado. Release individual controlado por #111.
3. **APIs:** Bulk, Combos, Promotions e Inventory sin controllers comerciales en master; Price Audit scaffold. Catalog/Taxonomy tienen pocas lecturas y Pricing cuatro lecturas administrativas. Writes, precio SKU/canal, importaciones y resto de rutas pendientes.
4. **Seguridad:** sin pruebas 401/403 por operación; Gateway/JWT/cliente Frontend incompletos. No inventar permisos G7. Bypass de demo no es política final.
5. **AMQP/DB:** Outbox Pricing parcial no acredita relay/consumer. Broker sin conexiones y con topología discrepante. AMQP bloqueado no detiene HTTP/DB independiente.

## H. Nomenclatura y contradicciones

1. El título actual de Backend #114 dice 16 funcionalidades; el cuerpo todavía habla de “16 MK” como identidad. El issue no se editó ni cerró. Propuesta pendiente: título “Matriz central de integración funcional — Hito 4” y texto “16 funcionalidades WF-001…WF-016; MK solo como referencia visual secundaria”. No editar ni cerrar el issue.
2. No hay contradicción funcional entre README y el índice: README enumera las funcionalidades en orden 001…016, mientras el índice asigna a cada wireframe WF-001…WF-016. Es diferencia de presentación y significado de artefacto, no discrepancia del catálogo.
3. Hallazgo UX real: el component-spec de [MK-003](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-003/component-spec.md) referencia MK-004-S01 y el de [MK-004](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-004/component-spec.md) referencia MK-003-S04. El component-spec de [MK-015](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-015/component-spec.md) no identifica pantallas MK-015-SXX y [MK-016](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/MK-016/component-spec.md) usa pantallas con prefijo MK-015. Owner: gobernanza UX del módulo / responsables de MK-003/004/015/016. Pendiente: reconciliar la atribución en las fuentes UX; la matriz no cambia nombres ni ownership.
4. OpenAPI rc.1 / AsyncAPI rc.2 no prueban homologación. Matriz intermodular y alineaciones mantienen pendientes por consumidor.
5. Exchanges/colas candidatos difieren de los físicos; no se eligió ni alteró configuración. Resolver con owner contractual.
6. Backend #121/#127/#128/#132 y FE #47 son parciales/candidato; no prueban integración completa, relay, deploy o E2E.

## I. Referencias y actualización

- [Índice funcional](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/wireframes/INDEX.md) · [README mockups](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/ux/mockups/README.md) · [OpenAPI](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/contratos/http/openapi.yaml) · [AsyncAPI](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/contratos/eventos/asyncapi.yaml).
- [DEC-F registro](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/arquitectura/decisiones/REGISTRO_DEC_F.md) · [matriz trazabilidad DEC-F](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/arquitectura/decisiones/MATRIZ_TRAZABILIDAD_DEC_F.md) · [matriz intermodular](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/integraciones/MATRIZ_INTERMODULAR_BACKEND.md).
- Issues backend transversales: [#115](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/115), [#19](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/19), [#21](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/21), [#111](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/111). Issues Frontend [#33](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/33), [#34](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/34), [#35](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/35), [#36](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/36), [#37](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/37), [#38](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/38), [#39](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/39), [#45](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/issues/45).
- Issues por owner: Bulk #88–94; Combos #79–87; Catalog #43–51; Promotions #70–78; Taxonomy #34–42; Pricing #24/#55–60; Price Audit #61–69; Inventory #97–105.
- Actualizar estados solo con fuente exacta, SHA, run, entorno y alcance. Separar implementación, integración, DB, AMQP, homologación, deploy y E2E. Enlazar en vez de copiar extensamente [MATRIZ_INTERMODULAR_BACKEND](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b/integraciones/MATRIZ_INTERMODULAR_BACKEND.md), [MATRIZ_DEPENDENCIAS](../ops/oracle/MATRIZ_DEPENDENCIAS.md), [RABBITMQ_COMPATIBILIDAD](../ops/oracle/RABBITMQ_COMPATIBILIDAD.md) y [ESTADO_ACTUAL](../ops/oracle/ESTADO_ACTUAL.md).

Conteo del resumen: 16 funcionalidades en el orden canónico del índice; WF-001…WF-016 son referencias a wireframes. La comparación OpenAPI tras esta corrección representa 141 registros por funcionalidad, 135 operationId/método/ruta únicos y 6 repeticiones justificadas de operaciones compartidas (ver §D); no hay operaciones OpenAPI omitidas ni tuplas documentadas fuera del contrato. Esto acredita cobertura documental del contrato fijado, no implementación ni runtime.
