# Consultas administrativas de Hito 4

## Catálogo

**PROPUESTA_H4** para homologación de Docs y frontend. [OpenAPI candidato](catalogo-admin.openapi.json).

| Operación | Método y ruta | Resultado |
| --- | --- | --- |
| `listarProductosAdministracion` | `GET /api/v1/productos/administracion` | Resúmenes de producto con versión y estado, más `meta`. |
| `obtenerProductoAdministracion` | `GET /api/v1/productos/administracion/{productoId}` | Resumen, imágenes ordenadas, atributos de producto y perfil físico disponible. |

Ambas operaciones exigen `userBearer` y `GESTOR_COMERCIAL` en Gateway y Catálogo. El header `X-Correlation-Id` acepta un UUID opcional. Gateway genera y devuelve uno si se omite. Las respuestas son `application/json` o `application/problem+json`.

El listado admite `estado`, `q` sobre nombre o SKU base, `categoriaId`, `marcaId`, `pagina` desde 1 y `tamanio` entre 1 y 100. El orden es por nombre e ID. La cuenta y los ítems se leen en la misma transacción de lectura. El detalle usa un UUID y devuelve `404 PRODUCTO_NO_ENCONTRADO` cuando falta el registro. Errores comunes: `400 VALIDACION`, `401 TOKEN_INVALIDO`, `403 SCOPE_INSUFICIENTE`, `500 ERROR_INTERNO` y `503 SERVICIO_NO_DISPONIBLE`.

`catalogVersion` es la versión persistida exigida para editar. `publicadoAlgunaVez` puede ser nulo en registros históricos. `perfilFisico` es nulo cuando falta el perfil, y sus medidas pueden ser nulas en un perfil parcial. Los atributos de producto conservan el valor JSON y su referencia. La selección por producto se devuelve en caracteristicasIdentificadoras. Una lista vacía indica que aún no existe selección. El atributo obligatorio de Taxonomía conserva su semántica. El estado de preparación se consulta en su endpoint existente.

## Pricing

[OpenAPI candidato de Pricing](pricing-admin.openapi.json).

| Operación | Método y ruta |
| --- | --- |
| `obtenerDefinicionPrecioProductoAdministracion` | `GET /api/v1/precios/administracion/productos/{productoId}` |
| `obtenerDefinicionPrecioSkuAdministracion` | `GET /api/v1/precios/administracion/skus/{sku}` |

`channelId` acepta los cuatro canales textuales canónicos y se omite para global. Ambas operaciones son humanas y devuelven la definición exacta de objetivo/canal. El `priceVersion` es el de la definición editable, incluso cuando una programación ya reservó una versión más nueva que la vigencia actual. `vigenciaActual` puede ser nula. Si solo existe un precio heredado, la consulta de la definición exacta responde `404 PRECIO_NO_ENCONTRADO`. La consulta comercial vigente sigue siendo la fuente del precio efectivo y su origen.

## Inventario

[OpenAPI candidato de Inventario](inventory-admin.openapi.json).

`listarSaldosFisicosAdministracion` responde a `GET /api/v1/inventario/administracion/saldos`. Es una consulta humana con filtros opcionales por SKU, ubicación y estado local, y paginación `pagina`/`tamanio`. Cada ítem identifica el saldo por SKU y ubicación, expone las cantidades persistidas, el nombre y el estado de la ubicación, y la versión de ese saldo. `skuActivo` indica el último estado de ciclo de vida conocido por Inventario y es nulo cuando no existe. `estado` usa la cantidad disponible y el umbral efectivo de SPEC-016 para esa ubicación. La consulta devuelve saldos con existencia física y también saldos registrados en cero. No agrega orígenes ni determina elegibilidad comercial. Una combinación sin saldo devuelve página vacía. Una caída de PostgreSQL devuelve `503 SERVICIO_NO_DISPONIBLE`.

## Price Audit y Combos

[OpenAPI candidato de Price Audit](price-audit-admin.openapi.json). La lista y el detalle humanos bajo /auditoria-precios/administracion aceptan SKU y canal nulos y devuelven target_type explícito. Los importes conservan la representación decimal del repositorio.

[OpenAPI candidato de Combos](combos-admin.openapi.json). POST /combos/administracion exige Idempotency-Key de 1 a 128 caracteres en el alfabeto definido. La clave se limita al sujeto G7, el recibo y el agregado se confirman en la misma transacción, y la misma clave y huella recuperan el ID sin llamar a proveedores otra vez una vez confirmada la creación. Otro cuerpo con la misma clave devuelve 409. La huella incluye el orden de los componentes. La ruta publicada /combos conserva su contrato.
