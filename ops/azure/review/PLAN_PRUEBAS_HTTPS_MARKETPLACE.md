# Plan de pruebas HTTPS — Marketplace Fase 1

**Preparado, NO EJECUTADO en Azure.** Requiere recursos/despliegue autorizados y
aprobación individual de las lecturas públicas. No activar operaciones para probar
este documento sin esas autorizaciones. Emisor JWT simulado exclusivamente local.

## Preparación de datos y evidencia

Usar una base HTTPS real de Azure con certificado válido, el manifiesto privado
revisado y el SHA/digests de los tres contenedores desplegados. Los identificadores,
slugs y rutas administrativas deben proceder del contrato y datos autorizados,
sin inventar endpoints ni sembrar/migrar la base compartida.

Seleccionar un producto real activo y elegible para Marketplace, con ID y slug
del mismo producto; categorías/marcas activas; casos existentes de inactivo y
borrador; y un slug cuya inexistencia haya sido comprobada. Si faltan datos,
registrar dependencia específica del owner de datos, sin crear mocks silenciosos.

Guardar por caso: fecha, URL/método/query, estado HTTP, body/cabeceras no sensibles,
correlación existente, SHA/digests, configuración pública aprobada y resultado.
Nunca registrar tokens, claves, contraseñas ni URLs de DB con credenciales.

## A. Antes de habilitar lecturas públicas

- Confirmar health/readiness y conexión real TLS/rol de Catalog y Taxonomy.
- Confirmar listas vacías, modo autenticado y flags legacy desactivados.
- Solicitudes sin JWT a las cinco rutas deben permanecer protegidas según contrato.
- Confirmar que no existe emisor simulado expuesto ni se declara homologación G7.

## B. Positivos después de aprobación individual

| Caso | Solicitud sin JWT | Aceptación |
|---|---|---|
| P01 | `GET /api/v1/categorias` | 200, listado comercial real y elegible |
| P02 | `GET /api/v1/marcas` | 200, listado comercial real y elegible |
| P03 | `GET /api/v1/productos?canal=MARKETPLACE` | 200, productos elegibles; conteo/paginación comerciales coherentes |
| P04 | `GET /api/v1/productos/{productoId}?canal=MARKETPLACE` | 200 para producto real elegible; validar ID y maestros |
| P05 | `GET /api/v1/productos/por-slug/{slug}?canal=MARKETPLACE` | **200 obligatorio**, mismo producto real de P04, con enriquecimiento Taxonomy correcto |

Se ejecuta cada caso únicamente si su operación está aprobada en Gateway y en los
servicios involucrados. Cuando las cinco estén autorizadas, las listas exactas son:

- Gateway: `listarCategorias`, `listarMarcas`, `listarProductos`, `obtenerProducto`,
  `obtenerProductoPorSlug`.
- Catalog: `listarProductos`, `obtenerProducto`, `obtenerProductoPorSlug`.
- Taxonomy: `listarCategorias`, `listarMarcas`.

No ampliar operaciones privadas, rutas por prefijo ni detalles administrativos.
Mantener separadas las lecturas públicas de preview/bypass heredados. Confirmar
HTTP Catalog → Taxonomy real con la observabilidad existente y los datos obtenidos;
health por sí solo no prueba esa integración. No fabricar identidades técnicas.

## C. Negativos obligatorios

| Caso | Condición | Aceptación |
|---|---|---|
| N01 | Producto inactivo por ID/slug | 404 comercial; ausente del listado Marketplace |
| N02 | Producto borrador por ID/slug | 404 comercial; sin preview ni filtración en conteos |
| N03 | Slug inexistente | 404 contractual; no fallback a otro producto |
| N04 | JWT inválido suministrado en una ruta pública | Rechazo de autenticación contractual; nunca fallback anónimo/200 |
| N05 | JWT expirado o issuer/firma incorrectos | Rechazo de autenticación; no acceso público alternativo |
| N06 | Escritura anónima contractual | Rechazo de autenticación, sin cambio de negocio |
| N07 | Ruta administrativa contractual sin JWT | Rechazo de autenticación/autorización; sin datos privados |
| N08 | JWT válido sin el permiso requerido | Rechazo de autorización según contrato; sin ampliar rol humano |
| N09 | Operación que no figura en las listas públicas | Mantiene autorización JWT; no hereda apertura de otras rutas |

Para N06, elegir ruta/payload contractual y recurso de prueba expresamente
autorizados. Un error de validación de payload no acredita autenticación; comprobar
el rechazo de acceso y la ausencia de escrituras. No ejecutar mutaciones positivas
sobre datos compartidos como parte de esta batería de lecturas.

## D. Persistencia, recursos y recuperación

Corroborar la conexión PostgreSQL desde cada servicio con rol mínimo y TLS
verify-full, sin revelar credenciales ni desactivar validación de certificados.
Registrar respuestas reales e indicadores de integración Catalog → Taxonomy.
Verificar ausencia de cambios de negocio tras consultas y rechazos por medios de
lectura autorizados; no afirmar integridad de toda la base por una captura parcial.

Medir CPU/créditos, memoria libre/por contenedor, estado, reinicios/OOM y latencias
de la batería de baja concurrencia. Registrar límites y cualquier dato no medido.

El rollback requiere su propio plan, versión oficial previa por digest, snapshot
de configuración no secreto y autorización del ensayo. Documentar restauración y
readiness reales; si es el primer despliegue, retirar un contenedor fallido no
acredita recuperación de una versión anterior. No ejecutar este ensayo ahora.

## Resultado a entregar después de la ejecución autorizada

URL HTTPS comunicable, SHA y tres digests, health/readiness, respuestas de P01–P05
(incluido slug), negativos N01–N09, prueba de DB y Catalog → Taxonomy, consumo real,
estado de contenedores y resultado del rollback autorizado. Hasta entonces estos
resultados se mantienen **NO EJECUTADOS**, separados de CI y publicación GHCR.
