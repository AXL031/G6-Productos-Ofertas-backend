import type { ContractRoute } from './contract-route.js';

/** Candidates authorized for implementation in the Phase 1 assignment.
 * Runtime lists remain empty until the operator explicitly enables reviewed rows.
 * Additions require an exact contract route and a separate public-read review.
 */
const publicReadRoutes = [
  ['catalog-svc', 'listarProductos', '/api/v1/productos'],
  ['catalog-svc', 'obtenerProducto', '/api/v1/productos/{productoId}'],
  [
    'catalog-svc',
    'obtenerProductoPorSlug',
    '/api/v1/productos/por-slug/{slug}',
  ],
  ['taxonomy-svc', 'listarCategorias', '/api/v1/categorias'],
  ['taxonomy-svc', 'listarMarcas', '/api/v1/marcas'],
  ['taxonomy-svc', 'obtenerSeoPorSlug', '/api/v1/seo/{slug}'],
  [
    'taxonomy-svc',
    'resolverSlugAnterior',
    '/api/v1/seo/resoluciones/{slugAnterior}',
  ],
  ['pricing-svc', 'consultarPrecios', '/api/v1/precios'],
  ['pricing-svc', 'obtenerPrecioSku', '/api/v1/precios/skus/{sku}'],
  ['promotions-svc', 'listarPromociones', '/api/v1/promociones'],
  ['combos-svc', 'obtenerCombo', '/api/v1/combos/{comboId}'],
  [
    'combos-svc',
    'consultarDisponibilidadCombo',
    '/api/v1/combos/{comboId}/disponibilidad',
  ],
  [
    'inventory-svc',
    'consultarDisponibilidadComercial',
    '/api/v1/inventario/disponibilidad/comercial',
  ],
  [
    'bulk-svc',
    'descargarPlantillaProductos',
    '/api/v1/carga-masiva/productos/plantilla',
  ],
] as const;

export function isEligiblePublicRead(route: ContractRoute): boolean {
  return (
    route.method === 'GET' &&
    publicReadRoutes.some(
      ([service, operationId, path]) =>
        route.service === service &&
        route.operationId === operationId &&
        route.path === path,
    )
  );
}
