# DATA-004 / #14 — Preparación offline de Inventario

Owner: Taco. Estado: **IMPLEMENTAR_PARCIAL**. Este directorio prepara una propuesta sintética de Inka Athletics y compara su contenido con un snapshot explícito. No contiene ejecutor SQL, cliente PostgreSQL/Supabase, credenciales ni modo de aplicación; no carga datos al arrancar el servicio. `ready_for_load` siempre es `false`.

## Datos y referencias

- `proposal.json`: dos ubicaciones sintéticas, umbral global 5, override de camisetas 3 y nueve saldos de siete SKU. Cantidades pequeñas para calzado, camisetas y balón, con variantes de stock normal/bajo/cero; sin filas de relleno. No afirma existencia de inventario físico, direcciones reales, reservas ni cuarentenas. Los UUID/códigos de ubicación conservan las referencias usadas por las pruebas locales de Inventario; deben contrastarse con el destino antes de cualquier carga.
- `catalog-reference.json`: extracto mínimo de la auditoría histórica de Catálogo publicada en la matriz de Pricing. Conserva SKU, identidades de producto/variante, tipo y estados observados; no replica precios ni fichas comerciales. Incluye siete SKU potencialmente vendibles y cuatro bases no vendibles, que el validador rechaza como saldo. Fuente fijada: Backend `9dcf22b9ad08eaf94eee5b4363b3a24e53ddd90a`, `scripts/seed/mcp/pricing/003_price_matrix.json`; blob Git y fecha de captura se conservan en el archivo. La captura es del 16 de octubre, no una lectura de la base actual ni una aceptación del owner de Catálogo. Los siete SKU figuran en BORRADOR en esa evidencia.
- `baseline-empty.json`: simulación explícita y vacía. No representa Supabase ni una inspección del entorno compartido.
- `dry-run.mjs`: validador/preparador sin conexión. El reporte completo contiene diff, hashes y filas candidatas del formato declarativo del framework de seeds, pero **no está registrado ni aprobado para ejecutarse allí**.

Los nombres/identidades de artículos vienen de la referencia publicada; cantidades, umbrales e instante de apertura son propuestas sintéticas de Taco. No son cotizaciones ni existencias verificadas del comercio. SKU de base de un padre con variantes no es una unidad vendible. No se inventan maestros de Catálogo/Taxonomía.

## Reproducir

Desde Backend:

```powershell
node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs
node apps/inventory-svc/data/data-f1/dry-run.mjs --baseline apps/inventory-svc/data/data-f1/baseline-empty.json --report dist/inventory-data-f1-dry-run.json
```

Crear previamente `dist/` si el build aún no lo ha generado. El programa imprime un resumen sin valores de conexión. El reporte es JSON UTF-8, incluye el candidato completo y puede inspeccionarse antes de coordinar la carga. No se leen variables `PG*`, `DATABASE_URL` ni credenciales. No hay `--apply`, SQL emitido ni llamadas de red. Cualquier argumento desconocido se rechaza. Los errores de archivos/JSON se minimizan para no volcar contenidos o rutas privadas. No se permite usar un input como archivo de salida del reporte.

Resultado de la simulación vacía: **38 INSERT propuestos**, cero conflictos y cero cambios ejecutados: 2 locations, 2 stock_threshold_override, 9 stock_balance, 9 inventory_operations, 7 kardex y 9 outbox. No se proponen rutas de cumplimiento ni se inventa el mapeo tienda Retail→ubicación. El GET/verificador comercial permanece indeterminado si ese mapeo no existe en su entorno.

Salida de proceso: 0 para una preparación sin conflicto (puede seguir siendo PARTIAL por dependencias), 2 para diff con conflictos, 1 para entrada/argumentos inválidos. Un exit 0 no autoriza una carga y no significa datos publicados, persistidos ni comercialmente disponibles.

## Reglas de preparación y comparación

- `on_hand` y umbrales deben caber en PostgreSQL `integer` no negativo. En la propuesta, `reserved=blocked=0`; no se aceptan reservas/bloqueos precargados sin sus antecedentes. No se inserta `available`, columna generada.
- Apertura positiva: versión 1, operación física `AJUSTE_ABSOLUTO`, Kardex desde cero y snapshot `inventory.stock.changed` propuestos en el mismo paquete. Apertura cero: versión 0 y operación física `INICIALIZACION_SKU`, sin movimiento Kardex de cantidad cero. Estos son registros propuestos para revisión de datos, no una ejecución del handler Bulk ni un comando recibido de Catálogo.
- `APLICADO`, `applied_at` y los saldos/eventos del candidato describen las filas que resultarían de una apertura aprobada; no son evidencia de que haya ocurrido. No se fabrican `accepted_at`, un cliente, un token ni resultados HTTP/asíncronos de un comando no recibido. La trazabilidad de cada cero se conserva en operación/manifiesto/evento, sin Kardex artificial.
- UUIDv5 estables por dataset y clave lógica, fingerprints y SHA-256 reproducibles sobre JSON canónico; esos hashes semánticos no sustituyen los hashes de bytes UTF-8/LF que exige el framework de carga al registrar un archivo. `bigint` de filas se serializa como cadena decimal. UUID equivalentes y timestamptz equivalentes se comparan sin conflictos falsos; se preservan los microsegundos. Los snapshots de eventos conservan la representación de versión del servicio. Reordenar filas/propiedades no altera el candidato.
- Comparación solo de columnas propuestas, con claves primarias y colisiones alternativas de código de ubicación, scope de umbral, operation_id/idempotency_key y event_id. Contenido distinto produce `CONFLICT`; no se genera UPDATE, DELETE, truncado ni reset de saldo/versiones. Registros ajenos a la propuesta se conservan.
- El replay completo devuelve `UNCHANGED`. Un evento que ya pasó a PUBLISHED se conserva publicado; no se propone volverlo a PENDING. Saldo existente sin su evidencia de apertura no habilita inventar un Kardex histórico: se informa `INCOMPLETE_OPENING_EVIDENCE`.
- Se verifican ubicación activa de destino, referencias internas, duplicados, SKU existente en la referencia y tipo potencialmente vendible. La referencia histórica no sustituye su validación vigente ni autoriza consultas cross-schema.

## Baseline real de entrada

Un export revisado debe usar `{version:1,schema:"inventory",source:{kind:"READ_ONLY_EXPORT",captured_at:"<ISO con zona>"},tables:{...}}` y contener arrays explícitos de **las siete tablas** del ejemplo, incluso si están vacías. No es un export de todos los schemas ni de todas las tablas de Inventario. Faltantes se rechazan; no se sustituyen por vacío. Se admite `available` cuando coincide con su fórmula y metadatos adicionales de filas (p. ej. created_at) que no entren en la comparación propuesta. Se valida la integridad de las ubicaciones referidas dentro de ese snapshot; no entregar un recorte que omita ubicaciones referenciadas.

La herramienta no obtiene ese export ni demuestra que un archivo etiquetado READ_ONLY_EXPORT provenga de una base real. El owner debe aportar origen, momento, alcance y evidencia de extracción autorizada de solo lectura; el reporte conserva el hash del input. No incluir DSN, secretos, datos de otros owners ni identidades personales en los JSON/evidencias. No usar una baseline productiva para justificar cargar la demo sin un destino y proceso aprobados.

## Dependencias concretas

1. **Poma / #12:** ratificar las siete identidades potencialmente vendibles y sus estados actuales con un export/API autorizado. La fuente histórica no permite afirmar que estén publicados; se mantienen bloqueos explícitos.
2. **Marco e Infraestructura:** aportar baseline de Inventario y contrastar colisiones con ubicaciones/umbrales/saldos ya existentes; validar destino aislado y release. No se sobreescriben saldos reales para hacer coincidir la propuesta.
3. **Marco / owner del framework #1:** `registry.schemas.inventory.tables` está vacío en la revisión consultada. El formato del candidato es compatible con la forma declarativa, pero faltan allowlists de tablas/columnas/claves y revisión de permisos reales. El framework consultado excluye Inbox/Outbox de los grants seed. Debe acordarse un mecanismo de apertura atómica que conserve operación/Kardex/evento, mediante runtime propio o una carga explícitamente autorizada; este directorio no concede permisos ni aplica esa decisión.
4. **Marco / #14:** cualquier escritura en Supabase, incluso una verificación con INSERT y ROLLBACK, exige autorización expresa, alcance y proceso de release aprobado. Este bloque no solicita ni ejecuta esa escritura.
5. **Owners de cumplimiento/Retail:** acordar referencias logísticas y mapeos antes de agregar `commercial_fulfillment_routes`; `external_ref=null` no atribuye una tienda externa ni concede acceso.

Normativa consultada: Docs `c36bd9a`, modelo físico y migraciones vigentes de Inventario, SPEC-015, DEC-F-002/005/009 y README/registry/dataset del framework de seeds. No se alteraron migraciones, permisos, scripts compartidos, contratos ni datos de otros contextos.
