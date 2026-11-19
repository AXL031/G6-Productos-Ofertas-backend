# Cierre de la carga masiva H5

## R01 y R04

Bulk admite un lote, conserva los documentos JSON exactos en su esquema privado y registra los comandos V3 en Outbox dentro de una transacción. Catalog obtiene cada documento por HTTPS desde Bulk, verifica longitud y SHA-256, y usa el procesamiento de filas existente. Bulk concilia el resultado V1 de R04 con las filas del comando admitido. Una reentrega conserva los identificadores de mensaje y de operación. Los comandos históricos conservan su payload y transporte.

El documento se guarda como una cadena JSON UTF-8 en un registro de la tabla interna de Bulk, con un UUID opaco y un vínculo a su comando. Esta opción evita coordinar un bucket con la transacción de admisión. Se conserva mientras se acredita una política de borrado que respete el mínimo de 30 días desde la conciliación terminal. Castilla y Poma deben validar el volumen, la capacidad y la retención con Infra.

La ruta privada es `GET /api/v1/interno/carga-masiva/contenidos/{contentId}`. El contrato fija consumidor `catalog-svc`, audiencia `api-productos`, scope `carga-masiva:contenidos:leer` y cabeceras `Content-Length` y `X-Content-SHA256`. G7 debe confirmar un token real de ese cliente y otorgar el scope. Infra debe acreditar que el DNS y HTTPS privados permiten a Catalog llegar a Bulk y que la ruta queda fuera del Gateway y APIM públicos. [OpenAPI](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/df0b09c651fab7f8fcdc693211109573f5e39a12/contratos/http/openapi.yaml) · [AsyncAPI](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/df0b09c651fab7f8fcdc693211109573f5e39a12/contratos/eventos/asyncapi.yaml)

1. Infra provisiona `g6.catalog.from.bulk` y verifica `g6.bulk.from.catalog`. La identidad Azure de cada emisor recibe Sender y la del consumidor recibe Receiver en su cola. G7 emite el grant HTTP por separado.
2. Instalar primero Catalog con el receptor V3, `CATALOG_H5_DESTINATIONS` incluyendo `g6.bulk.from.catalog`, el origen HTTPS privado en `CATALOG_BULK_CONTENT_ORIGIN` y el token URL y secreto del cliente de G7 en `CATALOG_BULK_CONTENT_TOKEN_URL` y `CATALOG_BULK_CONTENT_CLIENT_SECRET`.
3. Habilitar la ruta privada con `BULK_CATALOG_CONTENT_ENABLED=true` en el entorno autenticado de Bulk y probar tanto el token real de Catalog como las respuestas 401, 403 y 404. Medir la capacidad antes de habilitar el publicador.
4. Seleccionar `MESSAGING_PROVIDER=AZURE_SERVICE_BUS` y activar `BULK_SERVICE_BUS_CATALOG_RESULTS_ENABLED=true` en Bulk. Una vez probado el receptor R04 y el acceso privado, activar `BULK_SERVICE_BUS_CATALOG_COMMANDS_ENABLED=true` para importaciones de actualización que solo requieren Catalog. Las altas con dependencias de otros dominios quedan bloqueadas hasta cerrar los flujos correspondientes.
5. Ejecutar una actualización sintética con las dos imágenes fijadas por digest, forzar la reentrega de R01 y R04 y comprobar una sola mutación y un resultado durable. Verificar con el broker el límite de 256 KiB, recuperación tras falla y revisión de DLQ. Registrar SHA, digests, namespace, resultado, grants y responsables.

## Evidencia del fork

La CI de `1a6dcd6572aa0a744785006886e8ecc24e7dcff8` terminó correctamente. La prueba con PostgreSQL desechable, HTTP y JWT firmado de laboratorio pasó antes de publicar las imágenes del candidato. [CI](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44581488843) · [Verificación y publicación en GHCR](https://github.com/AXL031/G6-Productos-Ofertas-backend/actions/runs/44582001814)

| Imagen del fork | Digest |
| --- | --- |
| `bulk-svc` | `sha256:c0bcbec35763408f4469173946a5010da6410817bd67f1ca1a5cb8d339984df5` |
| `catalog-svc` | `sha256:917440ebd5ee7cfd3c475bf59ad743f0774a4171a12cb4d7da7102fe7c9e7c93` |

El 19 de noviembre de 2026, la suite `1c2c9b837e823eb5867789c803d8b320c26d52b1` pasó en el namespace Basic `g6-sb-h5-int-32cdqgbnlk7ow` usando los binarios extraídos de ambos digests. La ejecución sin ingress usó las identidades Azure separadas de Bulk y Catalog, PostgreSQL real descartable y la ruta HTTP por loopback con un JWT firmado de laboratorio. El runner registró `G6_H5_R01_R04_AZURE_PASS` y un caso aprobado en Vitest. Se comprobó la reentrega de ambas colas después de persistir cada efecto, una sola mutación de Catalog y la conciliación durable en Bulk. Las 14 colas del laboratorio terminaron con cero mensajes activos y cero en DLQ.

Queda pendiente comprobar en el ambiente destino el HTTPS privado con el token emitido por G7 y la configuración de exposición de Infra. La prueba Azure usó identidades administradas para el broker y un emisor de JWT de prueba para la descarga.

## Decisiones pendientes con los responsables

| Responsable | Operación | Evidencia para desbloquear |
| --- | --- | --- |
| Castilla y Poma | R01 y R04 | Revisar implementación, almacenamiento y compatibilidad histórica. Aceptar la actualización sintética por ambas colas con reentrega, resultado durable y resultado R04 dentro del límite Basic. |
| G7 e Infra | Descarga de contenido R01 | Grant efectivo para `catalog-svc` y prueba positiva de JWT y alcance. Evidencia de ruta privada, permisos Sender/Receiver y ausencia de exposición pública. |
| Castilla y Taco | R02 y R10 | Versionar el comando de ajuste de stock y sus resultados. Precisar identidad por SKU y ubicación, ajuste absoluto, causalidad, errores, reentrega y conciliación. Acordar qué papel tiene `inventory.stock.adjusted`. |
| Castilla y Vera | R03 y R14 | Versionar el comando de aplicación de precio y sus resultados. Precisar producto, valores y moneda según la especificación, concurrencia, causalidad, errores y conciliación por operación. |
| G5, G7 y Gateway | N01 consumo, restauración y consulta de cupón | Homologación HTTP, permisos por operación y prueba autenticada de reserva y snapshot, restauración ligada al consumo original y consulta de un resultado durable. |

Los comandos R02 y R03 y sus resultados todavía remiten a `GenericData` en AsyncAPI. Cada par requiere esquemas explícitos, ejemplos, versión y aceptación de productor y consumidor antes de activar la publicación. [Matriz H5](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/df0b09c651fab7f8fcdc693211109573f5e39a12/integraciones/MATRIZ-IMPLEMENTACION-SERVICE-BUS-H5.md)
