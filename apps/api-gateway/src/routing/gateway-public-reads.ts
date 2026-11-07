import type { ContractRoute } from './contract-route.js';

/** Explicit temporary academic read scope requested on 2026-11-06.
 * Runtime selection remains empty by default; never grants writes or identity.
 * Pricing multipart prevalidation is excluded: no implemented handler to certify.
 */
const publicReadRoutes = [
  [
    'catalog-svc',
    'obtenerContextoSku',
    'GET',
    '/api/v1/productos/skus/{sku}/contexto',
  ],
  ['catalog-svc', 'listarProductos', 'GET', '/api/v1/productos'],
  ['catalog-svc', 'obtenerProducto', 'GET', '/api/v1/productos/{productoId}'],
  ['taxonomy-svc', 'listarCategorias', 'GET', '/api/v1/categorias'],
  ['taxonomy-svc', 'listarMarcas', 'GET', '/api/v1/marcas'],
  ['pricing-svc', 'consultarPrecios', 'GET', '/api/v1/precios'],
  ['pricing-svc', 'obtenerPrecioSku', 'GET', '/api/v1/precios/skus/{sku}'],
  ['promotions-svc', 'listarPromociones', 'GET', '/api/v1/promociones'],
  [
    'promotions-svc',
    'evaluarPromociones',
    'POST',
    '/api/v1/promociones/evaluar',
  ],
  ['promotions-svc', 'validarCupon', 'POST', '/api/v1/cupones/validar'],
  [
    'promotions-svc',
    'obtenerRecomendaciones',
    'GET',
    '/api/v1/recomendaciones',
  ],
  ['combos-svc', 'obtenerCombo', 'GET', '/api/v1/combos/{comboId}'],
  [
    'inventory-svc',
    'consultarDisponibilidad',
    'GET',
    '/api/v1/inventario/disponibilidad',
  ],
  [
    'catalog-svc',
    'consultarDatosFisicos',
    'POST',
    '/api/v1/productos/datos-fisicos/consulta',
  ],
  [
    'taxonomy-svc',
    'resolverSlugCategoriaCreacion',
    'POST',
    '/api/v1/seo/categorias/slug/resolver',
  ],
  ['taxonomy-svc', 'obtenerSeoPorSlug', 'GET', '/api/v1/seo/{slug}'],
  [
    'taxonomy-svc',
    'resolverSlugAnterior',
    'GET',
    '/api/v1/seo/resoluciones/{slugAnterior}',
  ],
  [
    'catalog-svc',
    'obtenerProductoPorSlug',
    'GET',
    '/api/v1/productos/por-slug/{slug}',
  ],
  [
    'catalog-svc',
    'obtenerPreparacionProducto',
    'GET',
    '/api/v1/productos/{productoId}/preparacion',
  ],
  [
    'catalog-svc',
    'listarVariantesProducto',
    'GET',
    '/api/v1/productos/{productoId}/variantes',
  ],
  [
    'catalog-svc',
    'obtenerVariante',
    'GET',
    '/api/v1/productos/{productoId}/variantes/{variantId}',
  ],
  ['combos-svc', 'listarCombosAdmin', 'GET', '/api/v1/combos'],
  [
    'combos-svc',
    'consultarDisponibilidadCombo',
    'GET',
    '/api/v1/combos/{comboId}/disponibilidad',
  ],
  ['promotions-svc', 'listarCupones', 'GET', '/api/v1/cupones'],
  ['promotions-svc', 'obtenerCuponAdmin', 'GET', '/api/v1/cupones/{cuponId}'],
  [
    'promotions-svc',
    'obtenerPromocionAdmin',
    'GET',
    '/api/v1/promociones/{promocionId}',
  ],
  [
    'promotions-svc',
    'listarReglasRecomendacion',
    'GET',
    '/api/v1/recomendaciones/reglas',
  ],
  [
    'promotions-svc',
    'obtenerReglaRecomendacion',
    'GET',
    '/api/v1/recomendaciones/reglas/{reglaId}',
  ],
  [
    'taxonomy-svc',
    'obtenerArbolCategoriasAdmin',
    'GET',
    '/api/v1/categorias/arbol',
  ],
  [
    'taxonomy-svc',
    'obtenerCategoriaAdmin',
    'GET',
    '/api/v1/categorias/{categoriaId}',
  ],
  ['taxonomy-svc', 'listarCaracteristicas', 'GET', '/api/v1/caracteristicas'],
  [
    'taxonomy-svc',
    'obtenerCaracteristica',
    'GET',
    '/api/v1/caracteristicas/{caracteristicaId}',
  ],
  [
    'taxonomy-svc',
    'listarValoresCaracteristica',
    'GET',
    '/api/v1/caracteristicas/{caracteristicaId}/valores',
  ],
  ['taxonomy-svc', 'listarTiposProducto', 'GET', '/api/v1/tipos-producto'],
  [
    'taxonomy-svc',
    'obtenerTipoProducto',
    'GET',
    '/api/v1/tipos-producto/{tipoProductoId}',
  ],
  [
    'taxonomy-svc',
    'obtenerEsquemaTipoProducto',
    'GET',
    '/api/v1/tipos-producto/{tipoProductoId}/caracteristicas',
  ],
  ['taxonomy-svc', 'obtenerMarcaAdmin', 'GET', '/api/v1/marcas/{marcaId}'],
  [
    'taxonomy-svc',
    'obtenerOperacionMaestra',
    'GET',
    '/api/v1/taxonomia/operaciones/{operationId}',
  ],
  [
    'taxonomy-svc',
    'obtenerSeoCategoriaAdmin',
    'GET',
    '/api/v1/categorias/{categoriaId}/seo',
  ],
  [
    'taxonomy-svc',
    'listarHistorialSlugCategoria',
    'GET',
    '/api/v1/categorias/{categoriaId}/seo/historial',
  ],
  [
    'pricing-svc',
    'listarProgramacionesPrecioSku',
    'GET',
    '/api/v1/precios/skus/{sku}/programaciones',
  ],
  [
    'pricing-svc',
    'obtenerImportacionPrecios',
    'GET',
    '/api/v1/precios/importaciones/{batchId}',
  ],
  [
    'pricing-svc',
    'descargarReporteImportacionPrecios',
    'GET',
    '/api/v1/precios/importaciones/{batchId}/reporte',
  ],
  [
    'price-audit-svc',
    'listarAuditoriaPrecios',
    'GET',
    '/api/v1/auditoria-precios',
  ],
  [
    'price-audit-svc',
    'obtenerAuditoriaPrecio',
    'GET',
    '/api/v1/auditoria-precios/{auditId}',
  ],
  [
    'price-audit-svc',
    'obtenerExportacionAuditoriaPrecios',
    'GET',
    '/api/v1/auditoria-precios/exportaciones/{exportId}',
  ],
  [
    'price-audit-svc',
    'descargarExportacionAuditoriaPrecios',
    'GET',
    '/api/v1/auditoria-precios/exportaciones/{exportId}/archivo',
  ],
  [
    'bulk-svc',
    'descargarPlantillaProductos',
    'GET',
    '/api/v1/carga-masiva/productos/plantilla',
  ],
  [
    'bulk-svc',
    'obtenerImportacionGeneralProductos',
    'GET',
    '/api/v1/carga-masiva/productos/importaciones/{batchId}',
  ],
  [
    'bulk-svc',
    'descargarReporteImportacionGeneral',
    'GET',
    '/api/v1/carga-masiva/productos/importaciones/{batchId}/reporte',
  ],
  [
    'bulk-svc',
    'obtenerExportacionGeneralProductos',
    'GET',
    '/api/v1/carga-masiva/productos/exportaciones/{exportId}',
  ],
  [
    'bulk-svc',
    'descargarExportacionGeneralProductos',
    'GET',
    '/api/v1/carga-masiva/productos/exportaciones/{exportId}/archivo',
  ],
  [
    'inventory-svc',
    'obtenerUmbralesInventario',
    'GET',
    '/api/v1/inventario/umbrales',
  ],
  [
    'inventory-svc',
    'obtenerDashboardInventario',
    'GET',
    '/api/v1/inventario/dashboard',
  ],
  [
    'taxonomy-svc',
    'listarCategoriasAdmin',
    'GET',
    '/api/v1/categorias/administracion',
  ],
  ['taxonomy-svc', 'listarMarcasAdmin', 'GET', '/api/v1/marcas/administracion'],
  [
    'promotions-svc',
    'listarPromocionesAdmin',
    'GET',
    '/api/v1/promociones/administracion',
  ],
  [
    'pricing-svc',
    'obtenerPrecioBaseProducto',
    'GET',
    '/api/v1/precios/productos/{productoId}',
  ],
  [
    'pricing-svc',
    'listarProgramacionesPrecioProducto',
    'GET',
    '/api/v1/precios/productos/{productoId}/programaciones',
  ],
  [
    'inventory-svc',
    'listarTrasladosInventario',
    'GET',
    '/api/v1/inventario/traslados',
  ],
  [
    'inventory-svc',
    'obtenerTrasladoInventario',
    'GET',
    '/api/v1/inventario/traslados/{trasladoId}',
  ],
  [
    'catalog-svc',
    'resolverCodigoBarras',
    'POST',
    '/api/v1/productos/codigos-barras/resolver',
  ],
  [
    'inventory-svc',
    'consultarDisponibilidadComercial',
    'GET',
    '/api/v1/inventario/disponibilidad/comercial',
  ],
  [
    'inventory-svc',
    'consultarOperacionInventario',
    'GET',
    '/api/v1/inventario/operaciones/{operationId}',
  ],
  [
    'inventory-svc',
    'verificarCantidadComercial',
    'POST',
    '/api/v1/inventario/disponibilidad/comercial/verificar',
  ],
] as const;

export function isEligiblePublicRead(route: ContractRoute): boolean {
  return publicReadRoutes.some(
    ([service, operationId, method, path]) =>
      route.service === service &&
      route.operationId === operationId &&
      route.method === method &&
      route.path === path,
  );
}
