# Pasos 2 y 3 — clientes comerciales y proyecciones

Owner Axel Cueva, rama `cueva`, 23/10/2026. Issues #72/#73/#75.
Estado **IMPLEMENTAR_PARCIAL**. Fuentes: Docs
`1ee0d9e5a788dbe559a376bf96a60c6117af3956`, OpenAPI `0.6.0-rc.1`,
AsyncAPI `0.6.0-rc.3`, SPEC-005/006/007 y DEC-F-001/002/007/009/012.

## Paso 2: cliente HTTP implementado, sin registro productivo

`src/infrastructure/http/commercial-http.ts` implementa `HttpCommercialContext`.
Es un cliente saliente concreto con HTTP nativo, mapeo de los DTOs publicados y
las tres operaciones siguientes:

| operationId | Ruta | Contexto |
| --- | --- | --- |
| obtenerProducto | `GET /api/v1/productos/{productoId}?canal=…` | `ProductoDetalleComercial`, categoría y SKU vendibles visibles. |
| obtenerPrecioSku | `GET /api/v1/precios/skus/{sku}?canal=…&at=…` | `Precio`, canal específico o fallback global, vigencia/version/origen y moneda. |
| consultarDisponibilidadComercial | `GET /api/v1/inventario/disponibilidad/comercial?skus=…&canal=…` | `ConsultaDisponibilidadComercialResponse`, lotes de hasta 100 SKU. |

El cliente recibe un callback de credenciales propias de servicio; no obtiene
credenciales por su cuenta, no reenvía el token entrante y no elige una identidad
de Marketplace/Chatbot/Retail para suplantarla. Comunica al callback operationId,
audiencia `api-productos` y el scope publicado. Esto **no otorga** allowlist/grant.

No está registrado en `PromotionsSvcModule`, no hay flag nuevo para activarlo y
`COMMERCIAL_CONTEXT` conserva `blockedCommercialContext`. OpenAPI autoriza esas
lecturas de servicio a `modulo-marketplace`, `modulo-chatbot` y `modulo-retail`,
pero no a Promotions. El canal comercial de disponibilidad está vinculado a esas
identidades: definir la delegación propia es parte de la frontera pendiente.

Comportamiento interno implementado:

- Cesta: conserva orden/cantidad y las identidades producto/SKU; consulta una vez
  cada producto y precio durante esa llamada. No crea caché persistente. Conserva
  precios como strings decimales, valida identidad, moneda única, vigencia que
  contiene `at`, canal efectivo específico/global y oferta positiva no superior al
  regular. No consume cupones, reserva stock ni sobrescribe Pricing.
- La cesta necesita `product_id` para resolver el detalle. El DTO de entrada lo
  mantiene opcional: cuando falta, este cliente falla como dependencia específica
  en lugar de convertir el SKU a producto o inventar una búsqueda exacta.
- Origen recomendado: usa categoría del detalle comercial visible. Un 404 de
  esa consulta indica no visible comercialmente, no inexistencia administrativa.
- Recomendados: solo productos simples con `sku_base` confirmado. Consulta precio
  a un instante único de la llamada y disponibilidad comercial por SKU; no usa
  cantidades/ubicaciones internas ni suma saldos. Variantes siguen detenidas por
  D-REC-01/02, aunque el proveedor devolviese una sola variante activa.
- `INDETERMINADO`, respuesta de stock incompleta/duplicada, SKU ajeno o precio no
  verificable no se traducen a `AGOTADO`, precio cero ni lista vacía. En un
  candidato no visible no se inventa la disponibilidad obligatoria: se conserva
  fallo explícito hasta definir esa integración.
- HTTPS salvo loopback, correlación UUID por petición, sin redirecciones, cookies,
  caché HTTP o reintento. Límite de 2,5 s por operación del puerto (incluye callback,
  transporte y lectura del cuerpo), cancelación, respuesta máxima de 1 MiB y JSON
  UTF-8 válido. Errores sanitizados como `CommercialDependencyError`; sin cuerpos,
  tokens, URLs de proveedores ni diagnósticos en errores públicos.
- VENTAS no se transforma en un canal autorizado de las tres identidades actuales;
  esa llamada permanece fuera del cliente candidato hasta definición contractual.

Las pruebas HTTP lanzan un servidor nativo descartable y retornan DTOs sintéticos
explícitos. Prueban transporte y mapeo; no firma/JWKS, grants, despliegue ni llamada
a Catálogo/Pricing/Inventario compartidos.

## Paso 3: aplicación a las cuatro proyecciones propias

`src/coupons/assigned-projections.ts` aporta `createAssignedProjectionAdapter`.
Requiere **explícitamente** un decoder por evento. Su entrada normalizada deriva
del modelo físico propio; sus nombres TypeScript **no son un payload AMQP nuevo**.

| Evento oficial | Aplicación local implementada |
| --- | --- |
| catalog.product.deactivated | `catalog_projection`, tipo PRODUCTO, reference_id=product_id, active=false. |
| catalog.sku.deactivated | `catalog_projection`, tipo SKU, reference_id=sku, product_id separado, active=false. Cambiar el producto padre es rechazado por el guard oficial. |
| pricing.price.changed | `price_projection`, SKU/canal (incluido null global) y snapshot opaco, sin interpretar precios con campos inventados. |
| inventory.stock.changed | `stock_projection`, SKU y disponibilidad normalizada explícita; no agrega ubicaciones ni deriva disponibilidad de cantidades. |

Los writers usan únicamente tablas propias y consultas parametrizadas. Reciben
el cliente SQL del dispatcher existente: no abren otra transacción, conexión o
llamada HTTP; no hacen ACK ni declaran topología. Proyección e Inbox se confirman
en un solo COMMIT. Fallo SQL revierte ambos. Se conservan íntegros los guards de
versiones/tiempos, identidad inmutable, colisión y descarte de datos antiguos.

El snapshot conserva `event.data` original; `source_message_id` y
`source_occurred_at` vienen del envelope validado. La versión de negocio la aporta
el decoder como bigint positivo o null cuando corresponda al modelo: no se infiere
desde `schema_version`, no se reemplaza por un contador local ni se incrementa una
versión cero de un productor para hacerla encajar en el constraint.

**Lo que no está definido:** los cuatro `data` de AsyncAPI siguen siendo
`GenericData` (`additionalProperties: true`). Ni ese schema ni el catálogo de
eventos fijan campos para identidad, snapshot, versión, alcance o disponibilidad.
Por tanto, los cuatro decoders externos todavía no se implementan ni se registran.
`ASSIGNED_EVENT_ADAPTERS` permanece vacío y el runtime consumidor/pump protegido.
El writer no vuelve confiable un `producer` autodeclarado: la identidad de broker
independiente sigue siendo obligatoria en el dispatcher/runtime.

El smoke existente usa ahora los writers de `src/` y decoders `fixture_*`
explícitos **solo en test**. Conserva los escenarios de rollback, duplicado,
reentrega y ACK tras commit; comprueba además producto/SKU separados, rechazo de
cambio de padre sin Inbox durable, precio global/específico coexistentes y stock
normalizado. No se inventa el contrato de otro owner ni se desactiva un guard.

## Reproducción y dimensiones

```powershell
npm test -- apps/promotions-svc --maxWorkers=1
npm run test:e2e -- apps/promotions-svc --maxWorkers=1
npm run typecheck
npm run lint
npm run format:check
npm run build:promotions-svc
# Docker y G6_TEST_PYTHON según PERSISTENCE.md
node apps/promotions-svc/test/coupons.isolated.smoke.mjs
```

Registrar resultados reales por comando/SHA. No inferirlos de esta guía. Las
migraciones oficiales se leen con checksum y se aplican solo al contenedor de
prueba; no se modifican. No hay cambios en Supabase/broker compartidos, Gateway,
Catálogo/Pricing/Inventario, contratos, paquetes, CI, grants, DATA ni despliegue.

## Dependencias específicas pendientes

| Owner | Operación afectada | Condición verificable |
| --- | --- | --- |
| Marco/contratos G6 + Poma, Vera, Taco y G7 | Conectar `HttpCommercialContext` al servicio | Identidad propia y delegación de canal autorizadas para las tres lecturas, grant y callback real, prueba autenticada por entorno; luego registrar el cliente en el módulo. |
| Poma/Catálogo + integración G6 | Cestas sin product_id | Resolver canónicamente SKU a producto con operación o fuente versionada autorizada; no exigir un campo nuevo en el DTO. |
| Arquitectura + Catálogo/Pricing/Inventario | Recomendaciones con variantes y disponibilidad indeterminada | Resolución D-REC-01/02 y semántica de disponibilidad/ausencia compatible con el DTO de recomendación. |
| Poma/Catálogo, Vera/Pricing, Taco/Inventario + Marco | Decodificar los cuatro payloads AMQP | Publicar campos tipados y semántica de versión/snapshot/alcance, ejemplos de conformidad y evidencia del productor; implementar los decoders contra esa definición. |
| Marco/infra AMQP + G7 | Activar consumidor compartido | Identidad de productores/ACL/red/topología y recuperación homologadas, además de los gates independientes de cupones #33. |

Implementación interna y pruebas locales son dimensiones separadas de integración
autenticada compartida, homologación y despliegue. #72/#73/#75 continúan abiertos.
