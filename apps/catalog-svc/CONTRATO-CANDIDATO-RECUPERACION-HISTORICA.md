# Recuperación histórica — CONTRATO_CANDIDATO, PR #194 DRAFT

La autorización escrita de Marco fue confirmada explícitamente por el usuario en
este chat el 05/11/2026. Autoriza implementar el candidato en Catalog; no acredita
publicación en Docs/OpenAPI ni acuerdo sobre el discriminador AMQP.
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
simple o selección solo Pricing. No se permiten campos desconocidos, importes,
moneda ni ubicaciones. Dependencias: PRICING/INVENTARIO, únicas y no vacías.
UUID y orden de selección se normalizan para fingerprint; SKU queda literal.
Variantes únicas y pertenecientes al producto. Simple no admite variantIds.
Padre exige variantes explícitas para Inventory; su SKU base nunca es físico.
Pricing corresponde solo a producto/padre, nunca a variante.

Respuesta candidata 202: campos base de OperationAccepted y lista de operaciones:
```json
{"operation_id":"solicitudId","status":"ACCEPTED","correlation_id":"original","preparaciones":[{"dependencia":"INVENTARIO","sku":"literal","variant_id":null,"operation_id":"UUID de preparación"}]}
```

La solicitud y cada preparación son identidades distintas. Cada mensaje conserva
message_id, operation_id de preparación y correlación; 202 no es finalización.

## Idempotencia, transacción y errores propuestos

Fingerprint SHA-256 de producto, actor, dependencias y variantes normalizadas.
Lock por solicitud y después agregado; sin llamadas HTTP/monetarias bajo locks.
Recibo + todos los checks PENDING + Outbox se confirman juntos o se revierten.
Replay idéntico devuelve respuesta original sin publicar de nuevo.
Reutilización de solicitud con otra intención/producto/actor:
409 IDEMPOTENCY_CONFLICT. Solicitudes distintas sobre una preparación compiten
con un ganador y 409 PREPARACION_NO_REINTENTABLE para la otra.
No se reabre ningún check PENDING, REJECTED o COMPLETED.

Otros errores candidatos reutilizan códigos existentes: 400 VALIDACION,
401 TOKEN_INVALIDO, 403 SCOPE_INSUFICIENTE, 404 PRODUCTO_NO_ENCONTRADO /
VARIANTE_NO_ENCONTRADA, 409 CAMBIO_ESTRUCTURAL_NO_PERMITIDO si no es borrador,
503 SERVICIO_NO_DISPONIBLE por dependencia técnica/contrato Pricing pendiente.
Estas asociaciones HTTP/códigos aún requieren publicación contractual.

## Pricing: BLOCKED_CONTRACT únicamente para emisión histórica

Marco aprobó RECUPERACION_HISTORICA sobre pricing.product.initialization.requested.
Faltan campo discriminador, ubicación y versión compartida con Vera.
Catalog no define el campo, no elimina precio_regular obligatorio en ALTA_PRODUCTO,
no reconstruye importes y no emite todavía el comando histórico Pricing.
Selección que incluye Pricing falla cerrada con 503 SERVICIO_NO_DISPONIBLE
sin admitir efectos. Internamente se identifica BLOCKED_CONTRACT para PRICING;
el filtro HTTP conserva la respuesta sanitizada existente sin esos detalles.
Una solicitud explícita solo Inventory puede avanzar de forma independiente.

Puerto interno de adaptación sin implementación registrada: no es DTO AMQP ni
stub de éxito. Su futura implementación necesita contrato compartido y SHA Vera.
Pricing elegirá y persistirá instante, única vigencia elegible y decisión en su
primer procesamiento; replay reutilizará esa decisión sin modificar precios ni
emitir pricing.price.changed. Esa lógica sigue pendiente de Vera.
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
- Vera/Marco: discriminador en SPEC-013/AsyncAPI, implementación histórica y SHA.
- Taco: SHA único con userId de 8adcb6e y semántica sin ubicación de #199.
- E2E histórico integrado y activación simple/padre/variantes.
- Grants G7, homologación externa y despliegue permanecen independientes.
