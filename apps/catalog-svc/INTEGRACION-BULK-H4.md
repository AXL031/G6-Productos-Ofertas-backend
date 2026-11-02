# Catalog ↔ Bulk H4 — implementación del consumidor

Rama: `poma`. Base sincronizada por avance directo a master
`df5afa226e796b7560efdf4be8b7681d3974bbdd`, que incluye el merge Bulk #155
`94016a396093fed9fce15da20065316a9788957b` y los avances fusionados de #125.
Alcance: Catalog #48/#51, integración con Bulk #93. No cierra esos issues.

## Contrato y decisiones

Docs master contrastado: `783a60efa5772548fce66ef63198e17361d8460b`:
SPEC-001 `requisitos/specs/SPEC-001-carga-exportacion-masiva-productos.md`,
OpenAPI 0.6.0-rc.2, AsyncAPI 0.6.0-rc.4, DEC-G6-INT-01/08/09/12/13,
DEC-F-001 (SKU opaco e inmutable) y las invariantes de SPEC-003/004.
Guías Oracle, ficha Catalog, matriz de dependencias y compatibilidad RabbitMQ
consultadas. No se cambia un contrato ni se atribuye homologación externa.

La fixture `test/fixtures/0001_create_bulk_persistence.sql` es una copia exacta
para PostgreSQL DESECHABLE de Docs `datos/bulk/migrations/0001_create_bulk_persistence.sql`,
blob `c62b8a63fe9475b58135d139e25e8982d5ad6823` (comprobable con git hash-object).
No es una migración nueva ni una edición de la historia de Bulk; no se aplica
en bases compartidas ni mediante bootstrap productivo.

## Qué existía y qué se implementa

Existían bindings de comando/resultado, parser de envelope, Inbox/Outbox,
publisher confirmado y casos de uso HTTP de Catalog. El comando Bulk terminaba
en `BlockedCatalogHandler`; no había un procesamiento funcional por fila.

Ahora `CatalogMessageService` delega el comando al handler de Catalog, registrado
mediante un token interno para evitar un ciclo de dependencias de arranque.

- Framing de AsyncAPI: IDs de lote/chunk/fila, template 2, modo único, claves
  requeridas, filas/números únicos, familias contiguas y envelope UTF-8 <= 1 MiB.
  IDs UUID de operación se bloquean sin diferencias de mayúsculas/minúsculas;
  SKU y coordenadas comerciales conservan su texto original.
- ALTA: familia coherente por sku_base, un solo producto, variante por SKU
  explícito, validación con los DTO/casos de uso existentes. Precio inicial se
  solicita una vez por padre; Inventory por cada SKU vendible. Todo queda en
  borrador/preparación real; no se simulan precios, stock ni activación.
- ACTUALIZACION: producto existente y sku_base coincidente, sin migración del
  tipo ni cambio de identidad/estructura; padre/variantes se revalidan dentro de
  la transacción. La intención y versión esperada del padre deben concordar en
  toda la familia, se aplican una sola vez y cada variante conserva su versión
  esperada propia. No convierte actualización en alta.
- Se reutilizan los casos de uso de mutación con una transacción interna
  opcional. Las mutaciones hijas del mismo grupo no vuelven a tocar/versionar el
  padre ya mutado en esa transacción. Los defaults HTTP mantienen su conducta.
- Una transacción por comando/chunk, savepoint por familia. Un rechazo de
  negocio revierte la familia y deja resultados REJECTED por sus filas; otras
  familias válidas pueden completarse. Fallo técnico revierte el chunk entero y
  se propaga al transporte, sin resultado ficticio ni ACK de negocio.
  Las restricciones diferidas se comprueban antes de dar la familia por válida.
- `catalog.bulk.upsert.completed` describe el resultado de cada fila y puede
  contener rechazos. `catalog.bulk.upsert.rejected` se usa para rechazo previo
  al procesamiento de filas (incluye conflicto de intención del chunk).
  Resultado con `operation_id=batch_operation_id`, `causation_id` del comando
  recibido y correlación conservada; detalle de rechazo sin SQL/secretos.
- Aggregate, preparación, recibos y resultado Outbox se confirman juntos antes
  de retornar del handler. El runtime existente hace ACK después de ese retorno;
  el relay publica con confirms después de commit.

## Idempotencia durable sin migración

Se reutiliza Inbox, separando namespaces internos:

| Handler | Identidad en message_id | Persistencia |
|---|---|---|
| catalog.bulk.delivery.v1 | message_id de transporte | envelope original e inmutabilidad de la entrega |
| catalog.bulk.command.v1 | batch_operation_id | intención del chunk y resultado definitivo |
| catalog.bulk.row.v1 | row_operation_id | intención de fila y resultado definitivo |

Los dos últimos son recibos de operación internos, no mensajes AMQP nuevos.
No se deduplica por correlation_id. Advisory locks transaccionales por entrega,
chunk, fila y familia serializan concurrentes; las claves de filas/familias se
adquieren en orden. La escritura de los recibos es parte de la misma transacción.

Mismo row_operation_id y payload semántico (objetos con claves canonizadas)
reproduce el resultado sin efectos. Otro payload da IDEMPOTENCY_CONFLICT y
conserva el recibo original. Un replay mixto conserva el resultado de las filas
ya conocidas y rechaza identidades alteradas; no añade nuevas filas a una familia
parcialmente confirmada. Bulk ya conserva familias completas entre chunks.
Otro message_id para la misma intención no vuelve a crear/modificar entidades;
produce una respuesta causal al comando recibido. Duplicado exacto de entrega
reutiliza el Outbox ya persistido y no genera otra respuesta.

## Autoridad de Taxonomy y acceso

No se reenvía un bearer del archivo/comando ni se fabrica identidad humana.
CatalogBulkIdentity reutiliza client_credentials de Catalog con scope existente
`catalogo:leer`, identidad `modulo-productos` y audience `api-productos`,
verificados por firma/JWKS/issuer/expiración. Su caché es independiente de Pricing
(scope `precios:leer`), cuyo comportamiento permanece cubierto. Taxonomy usa los
GET de detalle/esquema/valores publicados y la correlación del comando.
Falta de credenciales/grant o caída/401/403 de Taxonomy es fallo técnico; no se
convierte en referencia inexistente ni en éxito. No se agrega bypass demo AMQP.

## Pruebas y límites de la evidencia

- `catalog-bulk.spec.ts`: framing, preservación SKU, límite 1 MiB, duplicados,
  modos, familias contiguas y canonicalización.
- Publisher: fixtures actualizadas desde GenericData vacío al payload tipado;
  se mantiene la prueba de exchange/routing/confirm sin relajar el contrato.
- `catalog-pricing-identity.http.e2e-spec.ts`: emisión G7 de fixture por HTTP y
  JWT RS256/JWKS locales; Bulk pide catalogo:leer y rechaza scopes incompatibles.
  No acredita token ni grant G7 real.
- Nuevos casos BULK en el runner PostgreSQL/TLS desechable: ALTA simple y familia
  de variantes, padre una vez, ACTUALIZACION y versiones propias, falta/stale de
  versión, replay concurrente y con otro message_id/chunk, payload conflictivo,
  resultados parciales y rollback completo ante fallo técnico inyectado.
- BULK-JOINT: Bulk se compila y ejecuta en otro proceso con importer, Outbox e
  Inbox reales. Env mínimo y credenciales solo de fixture. PostgreSQL 17/TLS y
  RabbitMQ 4.2.9 desechables; rol Bulk sin USAGE en Catalog y rol Catalog sin
  acceso a Bulk. Usa CSV v2, publicación/confirm, consumo Catalog, mutación y
  resultado durable; Bulk aplica CATALOGO y mantiene Pricing/Inventory PENDING.
  Replay de la misma entrega comprueba producto/preparación/resultado únicos y
  colas sin entregas pendientes. El DDL del schema Bulk solo lo prepara el
  administrador de infraestructura de prueba. Ningún proceso de servicio hace
  SQL cross-schema. No hay imports de código entre servicios: Bulk corre aparte.
- Taxonomy y la emisión del token usados en integración siguen siendo fixtures
  explícitos; no hay E2E con servicios externos reales ni navegador/Gateway.

Local: Docker ausente; los casos de PostgreSQL/RabbitMQ se omiten y requieren CI.
El resultado por SHA de CI se informa en el PR/entrega, sin inferir PASS de código
preparado. No se declara despliegue por ejecutar contenedores de prueba.

## Dependencias específicas y alcance que continúa

| Owner | Operación afectada | Condición verificable |
|---|---|---|
| Marco/Bulk + Poma/contratos | Archivo ACTUALIZACION de variantes antes de publicar | Bulk aún responde DEPENDENCY_PENDING al no resolver SKU→variant_id; lectura existente autorizada explícitamente y adaptador de Bulk, revalidación en Catalog cubierta con IDs resueltos |
| G7 + López | Validación de maestros en ejecución real | Credenciales/grant catalogo:leer de modulo-productos y GET Taxonomy compatibles probados por SHA; no se bloquea la lógica interna ni las pruebas con fixtures |
| Marco + owners | AMQP compartido | ACL, retry/DLX, bindings y recuperación autorizados/homologados; gate productivo existente permanece cerrado, solo pruebas aisladas habilitadas |
| Marco/operación | Release H4 | SHA/digest y pruebas conjuntas, perímetro/readiness y autorización individual; no ejecutado aquí |

No hay un bloqueo de payload/contrato para el handler que recibe los IDs definidos
por AsyncAPI. La resolución previa de variantes en archivos es una frontera
específica todavía pendiente; no se inventa una ruta ni se amplía una allowlist
HTTP unilateralmente en este PR. No se modifica Bulk, un contrato compartido,
RabbitMQ compartido, retry/DLX ni los N+1 pendientes del PR anterior.

## Validaciones locales de preparación

- Catalog: 446 unitarias PASS; 157 E2E PASS / 53 SKIP (Docker ausente).
- Caso final de duplicado UUID con distinta capitalización: 9 pruebas de framing
  PASS tras corregir normalización; una ejecución en sandbox falló por EPERM del
  directorio temporal y se repitió con TEMP/TMP dentro del workspace.
- Unitarias generales iniciales: 1773 PASS / 56 SKIP y un fallo del caso nuevo
  de UUID; corrección enfocada aprobada y repetición general en curso al redactar.
- E2E generales: 892 PASS / 182 SKIP. No representan las pruebas omitidas de DB.
- Typecheck, lint, formato, build:catalog-svc, tsc estricto de E2E afectados y
  git diff --check: PASS. Las fixtures antiguas de publisher con GenericData vacío
  se actualizaron al schema tipado y sus 13 pruebas volvieron a pasar.
- Prueba BULK-JOINT y nuevos casos PostgreSQL: requieren Docker/CI. El resultado
  efectivo por SHA se incorporará a la descripción del PR y a la entrega.
