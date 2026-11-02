# Puntos 2 y 3 — filtros monetarios y códigos de barras

Fecha de resolución suministrada: 2026-10-23. Owner: Gabriel Poma, rama `poma`.
Refs #46 y #23; soporte de reglas/persistencia de #45/#44.

## Autoridad y fuentes

El owner entregó «Resolución del punto 2 — Filtros comerciales precioMin y
precioMax» y «Resolución D-CAT-01..04 — Asociación código de barras → SKU» y
solicitó su implementación. La primera comunica aprobación funcional de Marco y
confirmaciones de Leonardo, con dependencias técnicas explícitas. La segunda
cierra la definición funcional del owner y conserva pendiente el registro y la
ratificación arquitectónica. Esta implementación no acredita grants, aceptación
externa ni despliegue.

Fuentes contrastadas: Docs master `99456d8f08b1ab7bf08e256ca38070654552e94d`,
OpenAPI 0.6.0-rc.1, AsyncAPI 0.6.0-rc.3, SPEC-003/004/013, modelo físico de
Catálogo, DEC-F y matrices, alineaciones Retail/Marketplace y acuerdo H4. También
AGENTS, paquete operativo Marketplace H4 y las seis guías Oracle aplicables.
DEC-F-001/-002/-006/-011 mantienen separados identidad, stock, precio y perfil.

Pricing se verificó en `origin/vera` `dff8b704cc1f2e1df5f87e17ed11d9c97c8f6e76`:
su módulo registra `PRICING_CATALOG_CONTEXT = null` y `PRICING_CHANNEL_IDS = {}`;
el guard comercial admite Marketplace/Chatbot/Retail, sin identidad técnica de
Catálogo. El OpenAPI tampoco publica un transporte interno SKU-contexto. No se
modifica `pricing-svc` desde `poma` ni se inventa esa operación.

## Punto 2 — implementación interna y frontera pendiente

Se implementa la proyección ligera de todos los SKU candidatos: base de simples
ACTIVO y variantes ACTIVA con padre ACTIVO, aplicando los filtros propios de
Catálogo. El padre con variantes nunca participa por su SKU base.

`CatalogPriceFilter` consulta `GET /api/v1/precios` en lotes de hasta 100 SKU,
deduplicados, con un único `at`, canal y correlación por búsqueda. Usa hasta tres
solicitudes concurrentes y un plazo global de 10 s, incluida la obtención del
token. Un fallo cancela la evaluación; no se devuelve un conjunto parcial.

La frontera `CATALOG_PRICING_IDENTITY` obtiene la autorización técnica propia;
**no tiene un proveedor productivo inventado**. Nunca recibe el Bearer entrante
del consumidor. Requiere `CATALOG_PRICING_URL` privado y un proveedor de identidad
autorizado. Mientras falte, una búsqueda con candidatos y filtro monetario devuelve
503. Un conjunto de candidatos realmente vacío puede resolverse vacío sin Pricing.
La búsqueda ordinaria sin rango no depende de esa frontera.

Se conservan los lexemas decimales de los parámetros y del JSON de Pricing antes
de redondearlos a `number`. La comparación inclusiva es decimal exacta, también
con exponentes y sin expandir exponentes enormes. Se usa oferta resuelta cuando
existe; en otro caso regular. Solo PEN coincide, sin conversión ni fallback
monetario propio. Herencia, overrides, vigencia y canal los decide Pricing; se
valida su respuesta, pero no se reimplementa su resolver.

Ausencia de un SKU en un lote exitoso significa ausencia de precio. Duplicados,
SKU inesperados, datos inválidos, canal incoherente y errores técnicos devuelven
503. No se comparan stock, cupones ni promociones condicionales. El CSV contractual
no representa sin ambigüedad un SKU que contenga coma: ese caso falla de forma
explícita hasta un acuerdo de representación; no se divide ni transforma el SKU.

Después de evaluar todos los SKU, se deduplican `product_id`; COUNT, orden por
nombre/ID y página se calculan en SQL sobre los IDs coincidentes. Solo se hidratan
imágenes/atributos de esa página. La relectura final verifica de nuevo los filtros
de Catálogo y usa un mismo snapshot para COUNT y página. La selección inicial y
la relectura final son transacciones distintas; no se promete un snapshot único
de Catálogo y Pricing si cambian datos concurrentemente.

Se conserva el 503 previo para rangos monetarios en estados administrativos no
ACTIVO y modos demo. Sus consultas sin rango y las proyecciones públicas siguen
iguales. `skuContext` implementa el contexto autoritativo **local**, de solo
lectura y sin Pricing, para una conexión futura autorizada; no agrega una ruta.

## Punto 3 — implementación y migración separada

Se implementa el resolver contractual existente con el mismo DTO y guard Retail.
Código exacto, incluido texto no numérico, espacios y ceros iniciales; el resultado
es únicamente `{sku}`. Ausente, retirado o no comercializable produce el mismo
404 `CODIGO_BARRAS_NO_ENCONTRADO`. Un fallo técnico produce 503, nunca un falso 404.
No consulta Pricing ni Inventory.

La migración candidata aditiva
`migrations/0002_create_sku_barcodes.sql` crea una sola tabla de Catálogo:
`sku_barcodes`, referenciada a `sku_identity`. UNIQUE global permanente sobre el
código con comparación exacta, registro/retiro con actor y tiempo, FK restrictiva,
índice por SKU y guards de identidad/historia inmutables. Los grants runtime
permiten SELECT, INSERT de código/SKU/actor y actualizar solo retiro; no DELETE,
timestamps de registro suministrados por el runtime ni cambio de propietario.
La tabla histórica de trece entidades y la migración 0001 permanecen intactas.

Registro permitido en borrador/inactivo para SKU vendible; no se admite el SKU
base no vendible del padre. La resolución depende de los estados actuales y la
política [D-CAT-05/06](DECISION-D-CAT-05-06.md). Desactivar no elimina asociaciones;
reactivar recupera resolución solo si la asociación sigue vigente. Retiro terminal,
sin reasignación ni reutilización; repetir retiro conserva su auditoría original.

## Administración interna

Comando compilado: `node dist/apps/catalog-svc/barcode-admin.js`. Recibe JSON por
stdin; el Bearer nunca se coloca en argv ni se registra en logs. Verifica JWT con
el mismo validador criptográfico de Catálogo, rol `GESTOR_COMERCIAL`, identidad de
DB y permisos runtime antes de operar. El actor se obtiene del JWT verificado.

Operaciones internas (no endpoints ni errores HTTP nuevos):

```json
{"operation":"register","sku":"SKU-001","codigo_barras":"000123","authorization":"Bearer <JWT_GESTOR_COMERCIAL>"}
{"operation":"list","sku":"SKU-001","authorization":"Bearer <JWT_GESTOR_COMERCIAL>"}
{"operation":"retire","codigo_barras":"000123","authorization":"Bearer <JWT_GESTOR_COMERCIAL>"}
```

Cada comando recibe un solo objeto JSON. Requiere configuración PG/TLS propia y
Seguridad válida. No es un mecanismo de SQL manual. Los conflictos administrativos
usan códigos internos; fallos inesperados devuelven un diagnóstico sanitizado y
exit code 1. La auditoría exitosa queda en la asociación y se puede consultar.

**La migración no se aplica por bootstrap ni por el comando.** Solo se instala en
PostgreSQL desechable de pruebas. Para un destino compartido debe publicarse y
ejecutarse por el procedimiento oficial de migraciones y owner autorizado; aquí
no se opera Supabase ni Oracle. Una recuperación de aplicación conserva tabla e
historia; no se propone borrarlas como rollback.

## Verificación y límites

Pruebas locales de Catálogo: 349 unitarias PASS; 69 HTTP/E2E PASS y 37 omitidas por
Docker o integración no configurada. Las pruebas HTTP de Pricing usan un servidor
aislado explícito: prueban el cliente, no un grant G7 ni el resolver real de Vera.
Las pruebas de seguridad del resolver usan JWT RSA y discovery/JWKS reales locales.

La suite PostgreSQL desechable pasa a 21 casos: incluye alta concurrente de código,
unicidad histórica, múltiples etiquetas, retiro/auditoría, rechazo del padre no
vendible, estados padre/hija, permisos e inmutabilidad; además contexto SKU y
filtro de IDs previo a COUNT/página. Requiere ejecución real en CI por SHA.
No se modifica la fixture oficial 0001 para hacer pasar los casos nuevos.

Build, typecheck, lint, formato, diff check y tsc explícito de E2E pasan localmente.
El comando administrativo rechazó una credencial inválida con salida sanitizada,
sin acceder a PostgreSQL. La evidencia completa de CI debe consultarse por SHA;
un skip local no acredita persistencia ni migración aplicada al destino.

## Dependencias específicas para cerrar integración/operación

| Owner | Operación afectada | Condición verificable |
| --- | --- | --- |
| Vera + Arquitectura | Resolución comercial de precios | Provider productivo `PRICING_CATALOG_CONTEXT`, transporte interno de solo lectura acordado y mapeo canónico `PRICING_CHANNEL_IDS` configurado |
| G7/Seguridad + Vera + Poma | Catálogo → Pricing y lectura inversa de contexto | Client ID técnico definido, autorización en contrato/guard, grant y adquisición de credencial propia; conexión de `CATALOG_PRICING_IDENTITY` y prueba autenticada real |
| Marco/owner Docs | Registro de decisiones y modelo | Publicar las resoluciones, ratificar D-CAT-05/06 y actualizar SPEC/modelo/descriciones conservando DTO y seguridad |
| Marco/owner DB | Barcode en destino compartido | Revisar/versionar/aplicar 0002 por el procedimiento oficial, verificar checksum, rol/grants y probar el resolver en ese SHA |
| Retail + G6 | Integración autenticada barcode | Prueba consumer/provider con asociación autorizada y contrato existente; no se infiere de fixtures |

Estado: **IMPLEMENTAR_PARCIAL** del punto 2 por esas fronteras; punto 3 implementado
como candidato interno, pendiente de aplicar la migración al destino autorizado.
No implica cierre automático de issues, homologación, merge ni READY_FOR_DEPLOY.
