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
