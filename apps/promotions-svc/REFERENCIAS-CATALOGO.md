# Referencias administrativas — #74 / #77, paso 1

Owner: Axel Cueva, rama `cueva`. Fuente: Docs G6
`1ee0d9e5a788dbe559a376bf96a60c6117af3956`, OpenAPI `0.6.0-rc.1`,
SPEC-006/007 y DEC-F-001/007/012. Estado: **IMPLEMENTAR_PARCIAL**.

## Selectores del frontend

El cliente administrativo implementa estas consultas con el mismo callback de
sesión de usuario que las operaciones de Promotions, a través del Gateway:

| operationId | Consulta | Forma publicada |
| --- | --- | --- |
| listarProductos | `GET /api/v1/productos?estado=ACTIVO&pagina=…&tamanio=100` | `PaginaProductosComercial`, paginación en raíz; `product_id`, `categoria_id`, `tiene_variantes`, `sku_base` opcional. |
| listarVariantesProducto | `GET /api/v1/productos/{productoId}/variantes?estado=ACTIVA&pagina=…&tamanio=100` | `PaginaVariantes`, `meta` y `Variante` con `variant_id`, `sku`, `status`. |
| listarCategoriasAdmin | `GET /api/v1/categorias/administracion?estado=ACTIVO&pagina=…&tamanio=100` | `PaginaCategoriasAdmin`, `meta` y `CategoriaAdmin` con `categoriaId`, `nombre`, `estado`, `version`. |

No usa la ruta `/categorias`, que exige serviceBearer. El canal no se inventa
para una selección administrativa de usuario. Producto completo conserva su ID;
SKU específico conserva su código. No se trata barcode, producto o variante como
un SKU. El DTO comercial no lleva `status`: la actividad procede de la consulta
activa documentada, no de completar un campo ausente. Las variantes y categorías
sí se filtran por su estado publicado. Un producto simple sin SKU confirmado
produce error visible en vez de fabricar una referencia.

Las listas se recorren completas antes de entregar resultados, con detección de
páginas incompletas/inconsistentes e identidades repetidas. Una caída intermedia
no devuelve una lista parcial. Cada lectura de selector tiene cancelación y un
límite total de 7,5 s, sin reintento, caché de resultados ni fallback a fixtures.
La política técnica de hasta 1.000 páginas no redefine el máximo de negocio.

El modo API sin proveedor de sesión conserva su bloqueo. Estas lecturas no
acreditan autorización compartida, despliegue ni disponibilidad efectiva de los
handlers de otro owner. Las pruebas HTTP usan fixtures explícitos y las pruebas
React reutilizan las pantallas existentes; no son una prueba del Catálogo remoto.

## Verificación autoritativa en Promotions

`ADMIN_REFERENCES` conserva `blockedAdminReferences`. Crear, editar y activar
promociones/reglas sigue requiriendo esa comprobación; los IDs seleccionados en el
navegador no son evidencia confiable de existencia/actividad en el backend.

La afirmación anterior de que faltaban DTOs por `GenericData` no describe estas
consultas HTTP: los DTOs sí existen. Los límites concretos son de operación y
autorización:

- `listarProductos`, `obtenerProducto` y `listarCategorias` tienen allowlist de
  servicio `modulo-marketplace`, `modulo-chatbot`, `modulo-retail`; no incluyen a
  `promotions-svc`. Los consumidores de canal deben informar `canal` y reciben
  visibilidad comercial de ese canal, no una certificación administrativa global.
- `listarVariantesProducto` y `listarCategoriasAdmin` exigen `userBearer`, no
  credenciales de servicio. No se convierte el token de usuario del request en
  una identidad técnica, ni se obtiene la identidad de un canal ajeno.
- El detalle comercial no publica estado administrativo y no ofrece una búsqueda
  global de SKU que certifique actividad independiente del canal. Un 404 comercial
  no demuestra por sí solo inexistencia administrativa.

## Dependencia específica

| Owner | Operación afectada | Condición verificable de desbloqueo |
| --- | --- | --- |
| Marco/contratos + Poma/Catálogo, López/Taxonomía y G7 | Adaptador backend de `AdminReferences.verify` para crear/editar/activar campañas y reglas | Definir una operación y una identidad propia autorizadas para verificar existencia/actividad de productos, SKU y categorías; publicar semántica de ausencia/inactividad/fallo y demostrar acceso autenticado. Después implementar ese adaptador dentro de Promotions y probarlo con PostgreSQL real. |
| G7 / integración de sesión frontend + owners de Catálogo/Taxonomía | Ejecutar selectores en entorno compartido | Callback real de access token de usuario, permisos y origen Gateway configurados, handlers disponibles y prueba autenticada por entorno. |

Esta entrega no cambia contratos, Gateway, Catálogo/Taxonomía, permisos, topología,
migraciones, datos compartidos ni flags de activación. No solicita ni presupone
aprobaciones. Implementación, pruebas locales, integración autenticada compartida,
homologación y despliegue se informan por separado.
