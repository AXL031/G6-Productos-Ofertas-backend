# Bloque 05 — Preparación de datos iniciales de Inventario

Fecha: 17 de octubre de 2026. Rama: `taco`. Base: `fa2f86e`. Issue: [#14 — DATA-004](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/14). Estado final: **PARTIAL**. Preparación offline implementada y validada; no se cargaron datos ni se ejecutó SQL.

## Fuentes y límites

Se leyó `AGENTS.md`, se verificaron rama/ownership y se consultaron en GitHub los trece issues de Taco: todos siguen abiertos. #14 autoriza preparación/dry-run y exige autorización expresa de Marco, alcance y release para cualquier escritura en Supabase. También se consultaron #12 y los comentarios de coordinación #12/#14: sus fixtures no bloquean implementar las invariantes internas.

Docs master verificado en `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`: SPEC-015, DEC-F-002/005/009, modelo físico y migraciones vigentes de Inventario. Se aplicaron las recomendaciones de `supabase-postgres-best-practices` sobre rangos/tipos, sin cambios de schema ni conexión a Supabase.

Backend master remoto consultado: `9dcf22b9ad08eaf94eee5b4363b3a24e53ddd90a`. Se revisaron en modo lectura README/registry/dataset del framework de seeds y la matriz de Pricing `scripts/seed/mcp/pricing/003_price_matrix.json`. El framework reserva identidades genéricas pendientes de revisión; para esta propuesta se utilizan las identidades concretas de artículos ya referenciados en la matriz de auditoría publicada. No se copiaron precios ni se crearon productos/variantes ajenos al ownership de Inventario.

La matriz contiene once referencias: siete potencialmente vendibles y cuatro SKU base de padres no vendibles. Su captura histórica es del 16 de octubre y marca los siete potencialmente vendibles en BORRADOR. Es evidencia de preparación, no una consulta actual ni una aceptación de Catálogo. La propuesta conserva esa limitación y requiere confirmación vigente de Poma/#12.

## Entrega concreta

Todos los archivos nuevos están dentro de `apps/inventory-svc/data/data-f1/`:

- `catalog-reference.json`: extracto mínimo con commit/blob/ruta/fecha de la fuente y las once referencias. Permite rechazar SKU desconocidos o bases no vendibles.
- `proposal.json`: dos ubicaciones, dos umbrales y nueve saldos sintéticos de siete SKU de Inka Athletics. Hay stock normal/bajo/cero con cantidades pequeñas, sin reservas ni cuarentenas fabricadas. Las ubicaciones usan las identidades de los fixtures existentes del servicio, sujetas a comparación con el destino real; no afirman direcciones ni mapeos Retail verificados.
- `baseline-empty.json`: simulación vacía explícita, nunca presentada como snapshot de Supabase.
- `dry-run.mjs`: validador/preparador offline; acepta únicamente baseline y archivo de reporte. No importa cliente PostgreSQL/Supabase, no lee credenciales, no conecta, no emite SQL y no tiene modo apply.
- `dry-run.test.mjs`: 27 pruebas con Node, ejecutadas aparte de Vitest porque la configuración compartida solo incluye `.spec.ts`.
- `README.md`: comandos, formato del snapshot, límites de comparación, trazabilidad y condiciones de desbloqueo.

La propuesta produce **38 filas candidatas**: 2 ubicaciones, 2 umbrales, 9 saldos, 9 operaciones de apertura, 7 Kardex y 9 snapshots Outbox. Las cantidades propuestas, el instante de apertura y los registros futuros no representan hechos físicos ni ejecuciones ocurridas. Se diferencian explícitamente en el formato y en la documentación.

Apertura positiva: versión 1, operación física AJUSTE_ABSOLUTO, Kardex desde cero y evento de saldo propuestos. Apertura cero: versión 0, operación INICIALIZACION_SKU, sin Kardex artificial de cantidad cero y con operación/evento como trazabilidad. No se inventa admisión HTTP (`accepted_at`), cliente técnico, identidad humana ni comando recibido de Catálogo/Bulk. `available` queda fuera de la fila porque es generada en PostgreSQL. No se propone ningún mapeo de cumplimiento externo.

Comparación: INSERT/UNCHANGED/CONFLICT, sin UPDATE/DELETE/reset. Verifica claves y colisiones alternativas, referencias internas, ubicación activa, enteros PostgreSQL, umbral global/por SKU y contenido. Repetición completa da UNCHANGED; Outbox ya publicado no se devuelve a PENDING. Un saldo existente sin su evidencia atómica de apertura no autoriza fabricar historia; se bloquean las filas faltantes con INCOMPLETE_OPENING_EVIDENCE. Se distinguen UUID equivalentes, bigint decimal y timestamps equivalentes sin perder microsegundos.

## Evidencia ejecutada

| Comando | Resultado |
| --- | --- |
| `node --test apps/inventory-svc/data/data-f1/dry-run.test.mjs` | PASS: 27 pruebas, cero omitidas |
| `node apps/inventory-svc/data/data-f1/dry-run.mjs --baseline apps/inventory-svc/data/data-f1/baseline-empty.json --report dist/inventory-data-f1-dry-run.json` | PASS de preparación: PARTIAL, 38 INSERT propuestos, 0 conflictos, ready_for_load=false |
| `npm.cmd test` | PASS: 244 pruebas; 18 omitidas; 32 archivos aprobados y uno omitido |
| `npm.cmd run test:e2e`, con artefacto Gateway del bloque 04 | PASS: 91 pruebas en 11 archivos |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run format:check` | PASS |
| Prettier `--check` sobre los nuevos `.mjs`/`.json` | PASS |
| `npm.cmd run build:inventory-svc` | PASS |
| `git diff --check` | PASS al cierre |
| Conexión/SQL/Supabase/PostgreSQL/RabbitMQ reales, CI remoto y despliegue | NO EJECUTADO |

Hash semántico SHA-256 del candidato: `6463cda113854e9a7af0813b42927851c76c0073f4248a3c4f7b21c8105e80d9`. Se calcula sobre JSON canónico; no es el hash de bytes de un archivo de release. El reporte completo queda bajo `dist/`, ignorado por Git, y se regenera con el comando indicado.

Las pruebas comprueban repetición, orden de filas, timestamps/UUID equivalentes, precisión de microsegundos, conflictos de cantidad/versión/código, historial incompleto, SKU desconocidos/bases no vendibles, cantidades inválidas/overflow, ubicaciones inactivas/huérfanas, duplicados, umbrales por ubicación prohibidos, global ausente, fechas inválidas, baseline incompleta, available erróneo y preservación de filas ajenas. También verifican que CLI rechace apply y no imprima secretos sintéticos, y que un reporte no sobrescriba sus entradas.

## Pendientes específicos

| Owner | Operación/alcance | Desbloqueo verificable |
| --- | --- | --- |
| Poma / #12 | Referencias y condición comercial de los siete SKU | Export/API autorizado y revisión actual que ratifique identidades/tipo/estado; no inferir publicación de la matriz histórica |
| Marco e Infraestructura G6 | Baseline de Inventario y destino de la propuesta | Export de solo lectura con alcance, origen/fecha y evidencia; diff sin conflictos contra ese snapshot |
| Marco / owner de #1 | Registro y ejecución mediante framework de seeds | Revisar allowlists de Inventory y mecanismo de apertura atómica; en la versión consultada Inventory no tiene tablas registradas y los seed grants excluyen Outbox |
| Marco / #14 | Cualquier escritura en Supabase, incluso INSERT+ROLLBACK | Autorización expresa, alcance, destino y proceso de release aprobados; este bloque no la solicita ni ejecuta |
| Owners de cumplimiento/Retail | Mapeos públicos de cumplimiento y tienda externa | Referencias/logística ratificadas antes de proponer rutas comerciales o external_ref |

No se modificaron archivos compartidos de `scripts/seed`, registry/grants, otras aplicaciones, Frontend, Docs, migraciones ni contratos. La herramienta no declara permisos efectivos o conectividad por la existencia del README/registry.

Node local `22.16.0`, fuera del rango declarado por Backend; queda pendiente ejecutar con Node admitido y dependencias reales. La autorización Docker rechazada previamente no se volvió a solicitar. El cambio preexistente de `test/inventory.real.integration.spec.ts` se conserva intacto y se excluye del commit; SHA-256 `07C4C9A86E66895349C259B3295EDFD62DE1A6E6790E48A1D960B39BF8E763AA`.

Implementación local/dry-run: terminada. Validación contra base real, integración autenticada, homologación y despliegue: no acreditados. Errores obligatorios locales pendientes: ninguno. Cambios fuera del alcance: ninguno. El commit que incorpora este reporte identifica la entrega. No hubo push, PR, merge ni cierre de issues.
