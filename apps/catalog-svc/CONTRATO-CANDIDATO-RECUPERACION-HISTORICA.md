# Recuperación histórica — CONTRATO_CANDIDATO, PR #194 DRAFT

La autorización escrita de Marco fue confirmada explícitamente por el usuario en
este chat el 05/11/2026. Autoriza implementar el candidato en Catalog; no acredita
publicación en Docs/OpenAPI. El encargo del 06/11 autoriza el adaptador candidato
de Pricing #205 y las pruebas integrales con los HEAD exactos indicados.
No se modifican Docs, Pricing, Inventory, Gateway ni la política demo existente.

## Operación y autorización candidatas

`POST /api/v1/productos/{productoId}/preparacion/recuperar-historica`

JWT humano firmado, rol `GESTOR_COMERCIAL` y capacidad interna exacta
`CATALOG_RECUPERAR_PREPARACION_HISTORICA`, cerrada por defecto.
Propuesta local de concesión: `CATALOG_HISTORICAL_RECOVERY_ALLOWED_SUBJECTS`,
lista explícita de UUID sub separados por coma, validada al arranque e inyectada
como instantánea. Ausente/vacía deniega; valores inválidos/duplicados impiden
arrancar. No se añade scope G7 ni se confía en headers o claims de capacidad.
No admite bypass demo ni M2M. Gateway no se modifica para publicar el candidato.
Solo nueva admisión sobre producto BORRADOR. Replay exacto devuelve recibo sin
efectos nuevos aunque el agregado haya progresado.

## Propuesta explícita de DTO HTTP — no DTO oficial publicado

```json
{"solicitudId":"UUID","dependencias":["INVENTARIO"],"variantIds":["UUID de variante seleccionada"]}
```

`solicitudId` y `dependencias` obligatorios. `variantIds` puede omitirse para
simple o selección solo Pricing. No se permiten campos desconocidos, importes
ni ubicaciones. Dependencias: PRICING/INVENTARIO, únicas y no vacías.
UUID y orden de selección se normalizan para fingerprint; SKU queda literal.
Variantes únicas y pertenecientes al producto. Simple no admite variantIds.
Padre exige variantes explícitas para Inventory; su SKU base nunca es físico.
Pricing corresponde solo a producto/padre, nunca a variante.

### Delta HTTP pendiente de aprobación de Marco: moneda explícita

Si la selección incluye PRICING se propone exigir `moneda`, sin default:
`{"solicitudId":"UUID","dependencias":["PRICING","INVENTARIO"],"moneda":"USD"}`.
Tres letras mayúsculas de moneda ISO reconocidas por ICU del runtime Node;
se rechazan espacios, minúsculas y códigos desconocidos. No se convierte ni
deduce de Pricing, de Catalog o de un GET demo. Es afirmación humana de entrada:
Pricing conserva la autoridad y rechaza incompatibilidades con su vigencia.
`precio_regular` sigue prohibido en este DTO. Para Inventory-only se omite
moneda; se propone rechazarla si se envía para evitar intención irrelevante.
Este delta NO se presenta como aprobado ni publicado: necesita aprobación
de Marco antes de publicación normativa. Fragmento OpenAPI propuesto y cambios
SPEC/FLOW en `contracts/`, sin modificar Docs master ni Gateway.

Respuesta candidata 202: campos base de OperationAccepted y lista de operaciones:
```json
{"operation_id":"solicitudId","status":"ACCEPTED","correlation_id":"original","preparaciones":[{"dependencia":"INVENTARIO","sku":"literal","variant_id":null,"operation_id":"UUID de preparación"}]}
```

La solicitud y cada preparación son identidades distintas. Cada mensaje conserva
message_id, operation_id de preparación y correlación; 202 no es finalización.

## Idempotencia, transacción y errores propuestos

Fingerprint SHA-256 de producto, actor, dependencias, variantes normalizadas y
moneda explícita cuando incluye Pricing. Cambiar moneda con la misma clave
produce 409 IDEMPOTENCY_CONFLICT, incluso si se deshabilita el adaptador.
Lock por solicitud y después agregado; sin llamadas HTTP/monetarias bajo locks.
Recibo + todos los checks PENDING + Outbox se confirman juntos o se revierten.
Replay idéntico devuelve respuesta original sin publicar de nuevo.
Autorización y validación preceden el recibo. La consulta del recibo y su
fingerprint preceden la habilitación del adaptador: una solicitud ya admitida
se puede reproducir durante su deshabilitación sin permitir admisiones nuevas.
Reutilización de solicitud con otra intención/producto/actor:
409 IDEMPOTENCY_CONFLICT. Solicitudes distintas sobre una preparación compiten
con un ganador y 409 PREPARACION_NO_REINTENTABLE para la otra.
No se reabre ningún check PENDING, REJECTED o COMPLETED.

Otros errores candidatos reutilizan códigos existentes: 400 VALIDACION,
401 TOKEN_INVALIDO, 403 SCOPE_INSUFICIENTE, 404 PRODUCTO_NO_ENCONTRADO /
VARIANTE_NO_ENCONTRADA, 409 CAMBIO_ESTRUCTURAL_NO_PERMITIDO si no es borrador,
503 SERVICIO_NO_DISPONIBLE por dependencia técnica/contrato Pricing pendiente.
Estas asociaciones HTTP/códigos aún requieren publicación contractual.

## Pricing: adaptador candidato, cerrado por defecto

Marco aprobó RECUPERACION_HISTORICA sobre pricing.product.initialization.requested.
El campo acordado es `data.modalidad=RECUPERACION_HISTORICA`, fuente Pricing
#205 @7398e6fbc577ec3d595a6c04d4aa9f884fbf527d. Se conserva el mismo comando,
schema_version=1, productor, identidades y causalidad. Payload: product_id exacto,
sku_base, moneda explícita, channel_id=null y motivo_cambio=ALTA_PRODUCTO como
metadato; se omite precio_regular. ALTA_PRODUCTO ordinario conserva su importe
obligatorio. Catalog nunca emite pricing.price.changed.

El provider se registra, pero entrega null salvo NODE_ENV=test y
CATALOG_HISTORICAL_PRICING_CANDIDATE_ENABLED=true. Ausente/false deniega nueva
admisión Pricing con 503; true fuera de test o un valor inválido impide arrancar.
No hay habilitación productiva ni bypass por capacidad/rol/demo. El flag es
exclusivo de pruebas aisladas hasta publicación contractual y autorización
operativa. Habilitarlo no concede la capacidad humana, que permanece separada.
Inventory-only es independiente. Los recibos existentes sí pueden reproducirse.

Pricing selecciona/persiste instante, vigencia y decisión en su primer
procesamiento; replays reutilizan la decisión sin modificar dinero ni emitir
pricing.price.changed. Esto se verifica contra su módulo real fijado por SHA,
sin importar código Pricing en el runtime Catalog.
Catalog exige price_version positivo y vigencia_id no vacío en COMPLETED, además
del productor autenticado y causalidad vigente. REJECTED permanece terminal.

## Propuesta de migración aditiva

`migrations/0004_historical_preparation_requests.sql` es candidata. No modifica
migraciones históricas y no se aplicó en Supabase compartida; solo en PostgreSQL
descartable durante pruebas. Tabla local con PK solicitud, FK/índice producto,
sujeto, correlación, fingerprint, selección y recibo. RLS y SELECT/INSERT solo
para catalog_app, sin UPDATE/DELETE. Es autorización del rol runtime del servicio,
no acceso directo de usuarios ni exposición por Data API. No crea roles/grants
ajenos ni guarda JWT, precio o saldo. Bootstrap no ejecuta migraciones.
Aplicación compartida/despliegue necesita proceso/autorización separados.

## Pendientes

- Revisar/publicar DTO, errores y concesión interna de esta propuesta.
- Marco: aprobar el delta HTTP moneda y publicar operación/DTO/errores.
- Marco/contratos: publicar SPEC-013/AsyncAPI conforme al patch de Vera #205.
- Inventory consolidado #176: 56aa4322725060b529bf316872f891582d7d1b2e.
- Ejecución integral por SHA y resultados: BLOQUE-A.md y CI final de #194.
- Grants G7, homologación externa y despliegue permanecen independientes.
