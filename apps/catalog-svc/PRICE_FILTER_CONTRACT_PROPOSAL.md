# Propuesta de contrato: listado de productos filtrado por precio

Estado: propuesta para revisión; no modifica OpenAPI ni habilita una nueva operación.

## Problema observado

El listado comercial obtiene candidatos de Catálogo, consulta Pricing en lotes de hasta 100 SKU y aplica el rango monetario antes de devolver la página. Este orden preserva el total y la paginación, pero requiere recorrer el universo elegible completo. Paginar los candidatos antes de consultar Pricing reduciría solicitudes, a costa de páginas incompletas y `total`/`totalPaginas` incorrectos. Filtrar un producto si cualquiera de sus SKU coincide es la semántica que expresa el mapeo vigente de candidato SKU a `productId`.

## Propuesta de responsabilidades

- **Catálogo (owner: Gabriel Poma):** conserva la autoridad sobre elegibilidad de producto, texto/categoría/marca y orden del listado; deduplica coincidencias por `productId`; devuelve únicamente páginas completas y un total exacto del mismo conjunto.
- **Pricing (owner: Leonardo Vera):** conserva la autoridad sobre precio efectivo, vigencia, canal, moneda y alcance específico con fallback global. La evaluación usa un único instante `at` por solicitud y los SKU distintos de los candidatos.
- **Arquitectura (owner: Axel Cueva, con Catálogo y Pricing):** revisa la frontera de lectura y el mecanismo de ejecución antes de homologar cualquier extensión HTTP.

## Semántica requerida

1. `precioMin`/`precioMax` se comparan inclusivamente contra el precio efectivo vigente: precio de oferta cuando existe una oferta vigente; en otro caso, precio regular.
2. Se incluye el producto una sola vez cuando al menos uno de sus SKU elegibles tiene precio efectivo que cumple ambos límites. Varios SKU coincidentes no duplican filas ni el total.
3. Si `canal` está presente, se usa la resolución contractual de Pricing: precio específico del canal con fallback al global. Si se omite, se consulta el alcance global. No se infiere el canal desde la identidad del usuario.
4. La moneda y el comportamiento de ausencia de precio deben quedar explícitos en OpenAPI. Para no cambiar la búsqueda vigente, la propuesta inicial conserva `PEN` y excluye SKU sin precio vigente de un filtro monetario; nunca representa ausencia como cero. La aprobación funcional debe confirmar esta regla antes de codificarla como contrato estable.
5. El orden se aplica una sola vez en Catálogo, de forma determinista, con desempate por `productId`. La página se corta después de la evaluación de precios y deduplicación; `total` cuenta productos elegibles distintos que cumplen el filtro, y `totalPaginas = ceil(total / tamanio)`.
6. Una respuesta parcial de Pricing no permite calcular totales exactos: cualquier timeout, 5xx, JSON inválido o SKU omitido de manera no contractual produce `503 SERVICIO_NO_DISPONIBLE` en el listado filtrado. No se devuelve una página parcial ni se reutiliza caché obsoleta.

## Extensión por homologar

El `GET /api/v1/precios?skus=...` vigente admite hasta 100 SKU por llamada y resuelve precios, pero no publica filtrado comercial de conjuntos, cursores ni un total de productos de Catálogo. No se propone sobrecargarlo con parámetros `precioMin`/`precioMax` que cambien su significado. Catálogo, Pricing y Arquitectura deben elegir y versionar uno de estos mecanismos antes de publicar cambios:

- **Opción preferida, contrato de consulta de candidatos:** Catálogo emite lotes paginados y estables de SKU elegibles bajo un snapshot/versión de consulta; Pricing evalúa cada lote para un `at`, canal, moneda y límites fijos; Catálogo consume todos los lotes para obtener conteo exacto y presenta la página final. La interfaz debe limitar tamaño de lote, duración del cursor y concurrencia, y hacer explícita la expiración del cursor.
- **Alternativa, operación de búsqueda coordinada:** una operación de lectura nueva, propiedad de Catálogo y homologada con Pricing, recibe los filtros comerciales y `at`, y responde `items`, `total`, `pagina`, `tamanio`, `totalPaginas`, `orden` y `canalResuelto`. La arquitectura debe definir autenticación servicio-a-servicio G7 y evitar transferir datos de precio a un consumidor que no esté autorizado.

La revisión debe incluir el máximo de resultados/lotes, límite de tiempo, cancelación, consistencia del snapshot, cambios de precio durante la consulta, orden permitido, precio ausente, fallos de Pricing y correlación. El desbloqueo requiere aprobación verificable de los owners de Catálogo y Pricing y revisión de Arquitectura; hasta entonces, cualquier fallo de dependencia sigue siendo 503 y la paginación actual mantiene exactitud aunque recorra candidatos.

## Compatibilidad inmediata

La implementación existente continúa usando únicamente el contrato batch vigente y sus límites publicados. No se cambia OpenAPI compartido, no se inventa una ruta pública, no se filtra un catálogo completo del lado navegador y no se cambia la semántica del listado sin homologación.
