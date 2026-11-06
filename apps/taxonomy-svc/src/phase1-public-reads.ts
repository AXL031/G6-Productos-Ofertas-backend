/** Temporary academic Phase 1 exception authorized by the operator on 2026-11-06.
 * Exact read routes only; explicit runtime selection, no inferred principal or IP.
 * Pricing prevalidation remains excluded until its real handler can be certified.
 */
export const PHASE1_PUBLIC_READS = [
  {
    operationId: 'listarCategorias',
    method: 'GET',
    path: '/api/v1/categorias',
  },
  {
    operationId: 'listarMarcas',
    method: 'GET',
    path: '/api/v1/marcas',
  },
  {
    operationId: 'resolverSlugCategoriaCreacion',
    method: 'POST',
    path: '/api/v1/seo/categorias/slug/resolver',
  },
  {
    operationId: 'obtenerSeoPorSlug',
    method: 'GET',
    path: '/api/v1/seo/{slug}',
  },
  {
    operationId: 'resolverSlugAnterior',
    method: 'GET',
    path: '/api/v1/seo/resoluciones/{slugAnterior}',
  },
  {
    operationId: 'obtenerArbolCategoriasAdmin',
    method: 'GET',
    path: '/api/v1/categorias/arbol',
  },
  {
    operationId: 'obtenerCategoriaAdmin',
    method: 'GET',
    path: '/api/v1/categorias/{categoriaId}',
  },
  {
    operationId: 'listarCaracteristicas',
    method: 'GET',
    path: '/api/v1/caracteristicas',
  },
  {
    operationId: 'obtenerCaracteristica',
    method: 'GET',
    path: '/api/v1/caracteristicas/{caracteristicaId}',
  },
  {
    operationId: 'listarValoresCaracteristica',
    method: 'GET',
    path: '/api/v1/caracteristicas/{caracteristicaId}/valores',
  },
  {
    operationId: 'listarTiposProducto',
    method: 'GET',
    path: '/api/v1/tipos-producto',
  },
  {
    operationId: 'obtenerTipoProducto',
    method: 'GET',
    path: '/api/v1/tipos-producto/{tipoProductoId}',
  },
  {
    operationId: 'obtenerEsquemaTipoProducto',
    method: 'GET',
    path: '/api/v1/tipos-producto/{tipoProductoId}/caracteristicas',
  },
  {
    operationId: 'obtenerMarcaAdmin',
    method: 'GET',
    path: '/api/v1/marcas/{marcaId}',
  },
  {
    operationId: 'obtenerOperacionMaestra',
    method: 'GET',
    path: '/api/v1/taxonomia/operaciones/{operationId}',
  },
  {
    operationId: 'obtenerSeoCategoriaAdmin',
    method: 'GET',
    path: '/api/v1/categorias/{categoriaId}/seo',
  },
  {
    operationId: 'listarHistorialSlugCategoria',
    method: 'GET',
    path: '/api/v1/categorias/{categoriaId}/seo/historial',
  },
  {
    operationId: 'listarCategoriasAdmin',
    method: 'GET',
    path: '/api/v1/categorias/administracion',
  },
  {
    operationId: 'listarMarcasAdmin',
    method: 'GET',
    path: '/api/v1/marcas/administracion',
  },
] as const;

export const PHASE1_PUBLIC_OPERATION_IDS = new Set<string>(
  PHASE1_PUBLIC_READS.map((route) => route.operationId),
);

export interface Phase1Request {
  readonly method?: string;
  readonly path?: string;
  readonly headers: { readonly authorization?: unknown };
}

export function isPhase1PublicRead(
  request: Phase1Request,
  mode: string | undefined,
  enabled: readonly string[] = [],
  operationId?: string,
): boolean {
  if (
    mode !== 'PUBLIC_READ_ONLY' ||
    request.headers.authorization !== undefined
  )
    return false;
  const path = request.path;
  if (!path || path.includes(String.fromCharCode(92)) || /%00/i.test(path))
    return false;
  const actual = path.split('/');
  try {
    if (actual.some((part) => ['.', '..'].includes(decodeURIComponent(part))))
      return false;
  } catch {
    return false;
  }
  return PHASE1_PUBLIC_READS.some((route) => {
    const expected = route.path.split('/');
    return (
      request.method === route.method &&
      enabled.includes(route.operationId) &&
      (operationId === undefined || route.operationId === operationId) &&
      expected.length === actual.length &&
      expected.every((part, index) =>
        part.startsWith('{')
          ? actual[index].length > 0 &&
            (part === '{sku}' || !/%2f|%5c/i.test(actual[index]))
          : part === actual[index],
      )
    );
  });
}
