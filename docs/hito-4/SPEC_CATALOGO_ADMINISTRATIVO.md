# Especificación de integración administrativa de Catálogo

Owner de Catálogo: Poma. Implementación candidata en [Backend PR #222](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/222). Consumidor revisado: [Frontend #73 en `f5d9f33`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-frontend/tree/f5d9f33c05fc1334896447e57bc0ed1224c8b24d).

Las mutaciones ya están publicadas en el [OpenAPI oficial de Docs `aba8d1c`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/aba8d1ca998cfcd2db1c4fa87654036a5a4c1ac1/contratos/http/openapi.yaml) con estado `provisional-internal`. Las dos lecturas administrativas están implementadas en el PR como `PROPUESTA_H4`, con su [OpenAPI candidato](catalogo-admin.openapi.json). Arquitectura/Docs debe ratificar esos dos operationId y esquemas e incorporarlos al OpenAPI oficial antes de tratarlos como homologados.

## Operaciones

Todas las rutas de esta tabla usan el prefijo `/api/v1` y un JWS humano G7 con `tipo: acceso` y rol `GESTOR_COMERCIAL`. Gateway y Catálogo verifican la identidad. El flujo humano no exige `aud: api-productos` ni `scope: catalogo:leer`. Puede enviarse `X-Correlation-Id` con un UUID para rastrear la solicitud.

| Método y ruta | operationId | DTO y respuesta |
| --- | --- | --- |
| GET /productos/administracion | `listarProductosAdministracion` | 200 `PaginaProductosAdministracion`, con `items: ProductoAdministracion[]` y `meta: { pagina, tamanio, total, totalPaginas }`. |
| GET /productos/administracion/{productoId} | `obtenerProductoAdministracion` | 200 `ProductoAdministracionDetalle`. ID UUID. 404 `PRODUCTO_NO_ENCONTRADO` si el ID no existe. |
| POST /productos | `crearProducto` | `ProductoCreateRequest` → 201 `ProductoDetalle`. Crea un borrador y devuelve `product_id`, `status: BORRADOR` y `catalog_version`. |
| PATCH /productos/{productoId} | `actualizarProducto` | `ProductoUpdateRequest` → 200 `ProductoDetalle`. Enviar los campos editados y el `catalogVersion` del último detalle. Devuelve el nuevo `catalog_version`. Una versión obsoleta devuelve 409 `VERSION_CONFLICT`. |

El resumen incluye `productId`, `estado`, `catalogVersion`, `nombre`, `descripcion`, `categoriaId`, `marcaId`, `tipoProductoId`, `skuBase`, `slug`, `tieneVariantes`, `publicadoAlgunaVez`, `creadoEn` y `actualizadoEn`. El detalle añade `imagenes`, `atributos`, `caracteristicasIdentificadoras` y `perfilFisico`. Consultar los tipos y los nulos en el OpenAPI candidato. Por ejemplo, `perfilFisico` puede ser nulo y `publicadoAlgunaVez` puede ser nulo en registros históricos.

El listado admite `estado=BORRADOR|ACTIVO|INACTIVO`, `q` literal por nombre o SKU base, `categoriaId`, `marcaId`, `pagina` desde 1 y `tamanio` de 1 a 100. Al omitir `estado`, consulta los tres estados. El orden es nombre e ID. Los filtros se aplican antes del conteo y de la paginación. Una combinación sin coincidencias devuelve 200 con `items: []`; una consulta inválida devuelve 400 `VALIDACION`.

Para editar, obtener el detalle y enviar, por ejemplo, `{"descripcion":"Edición QA","catalogVersion":0}` si la versión leída es 0. Releer el detalle tras el PATCH. Ante 409, obtener la versión vigente y revisar los cambios antes de reintentar. El contrato de escritura admite omitir la versión en escenarios existentes. El formulario administrativo debe enviarla para controlar concurrencia. Las rutas comerciales conservan su proyección y sus reglas de elegibilidad por canal.

## Selectores y diagnóstico del 403

| Uso | Ruta de Taxonomía | operationId | Identidad para Frontend |
| --- | --- | --- | --- |
| Categorías | GET /api/v1/categorias/administracion | `listarCategoriasAdmin` | JWS humano, `GESTOR_COMERCIAL` |
| Marcas | GET /api/v1/marcas/administracion | `listarMarcasAdmin` | JWS humano, `GESTOR_COMERCIAL` |
| Tipos de producto | GET /api/v1/tipos-producto | `listarTiposProducto` | JWS humano, `GESTOR_COMERCIAL` |
| Esquema del tipo | GET /api/v1/tipos-producto/{tipoProductoId}/caracteristicas | `obtenerEsquemaTipoProducto` | JWS humano, `GESTOR_COMERCIAL` |
| Detalle de característica | GET /api/v1/caracteristicas/{caracteristicaId} | `obtenerCaracteristica` | JWS humano, `GESTOR_COMERCIAL` |

Los filtros `categoriaId` y `marcaId` del listado de productos se aplican sobre los IDs persistidos y comparten el permiso del listado. Los selectores HTTP se atienden en Taxonomía. En el registro de Gateway, `GET /categorias` y `GET /marcas` pertenecen al perfil técnico de las lecturas comerciales protegidas. Enviar un JWT humano a esas rutas puede devolver 403; los selectores administrativos de arriba son los que usa Frontend #73. Las aprobaciones de lectura anónima de Azure corresponden a su propia política.

Si un selector administrativo devuelve 403, registrar método, ruta efectiva, SHA del Gateway y Taxonomía, `X-Correlation-Id` y presencia del rol, sin guardar el JWT. López debe verificar el guard y la ruta desplegada; G7 debe verificar que el JWS de acceso del usuario contiene `GESTOR_COMERCIAL`; operación de Azure debe confirmar que la solicitud llegó al Gateway QA correcto. Esta revisión de código no identifica cuál de esas condiciones causó el 403 observado.

Durante el alta o la edición, las validaciones de maestros de Catálogo tienen su propia llamada backend a Taxonomía. La configuración técnica de Catálogo usa `CATALOG_SERVICE_TOKEN_URL` y `CATALOG_SERVICE_CLIENT_SECRET` con `modulo-productos` y `catalogo:leer`. Verificar su provisión en QA con Poma, López y G7. Frontend usa únicamente su sesión humana.

## Evidencia y cierre

- La prueba `HTTP-50` de [persistencia de Catálogo](../../apps/catalog-svc/test/postgres.persistence.e2e-spec.ts) usa Gateway y Catálogo reales con PostgreSQL TLS desechable. Usa firma RS256 de prueba y proveedores explícitos de Taxonomía y preparación. Verifica creación 201, listado y detalle 200 para los tres estados, filtros por categoría y marca, edición 200, relectura persistida, 409 por versión obsoleta sin cambios y 404 comercial para borradores.
- Las [pruebas HTTP de autenticación](../../apps/catalog-svc/test/gateway-catalog.authenticated.e2e-spec.ts) verifican 401 sin Bearer y 403 con identidad insuficiente en Gateway y Catálogo. La ejecución y el SHA exacto de estas pruebas se consultan en los [checks del PR](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/pull/222/checks).
- **QA Azure con G7 real pendiente.** Operación Azure debe identificar la revisión de Gateway y Catálogo que expone las lecturas candidatas. G7 debe proveer un gestor y un usuario QA sin el rol. Poma y López deben aportar referencias de Taxonomía válidas para el alta. Con esas dependencias, ejecutar POST 201, listado y detalle 200, PATCH 200 con la versión leída, relectura con la nueva versión, PATCH obsoleto 409, lectura sin Bearer 401, usuario sin rol 403 y selectores administrativos 200. Registrar los SHA desplegados, HTTP y correlación por petición, además del ID del producto QA y su versión antes y después.
