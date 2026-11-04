# DATA-002 #12 — paquete para revisión de Marco

Revisión posterior: [respuesta a los seis puntos de auditoría](RESPUESTA-AUDITORIA.md)
y [metodología de estimación y plantillas](METODOLOGIA-PERFILES.md). Esta revisión
preserva el Excel y las 220 medidas, distingue artículo de embalaje, corrige
referencias por color y conserva un bloqueo semántico explícito antes de cargar.

Corrección puntual sobre el HEAD auditado `1ce011899c074e765e77772c049f2837c0462c4a`:
la matriz diferencia asociación por nombre/SKU de inspección visual individual.
JD9558 conserva Negro y su fotografía coincide por SHA-256 con la imagen oficial;
[evidencia reproducible y límites](evidence/jd9558-image-correspondence.json).
Su portada se reincorpora a B; las cuatro adicionales siguen separadas.

**PENDIENTE_APROBACION_MARCO**. Preparación offline; ningún SQL de escritura de
este paquete fue ejecutado en Supabase compartido. No cierra #12, habilita ventas
ni acredita integración autenticada, homologación, despliegue Oracle o readiness.

Owner Gabriel Poma, rama `poma`, destino propuesto `slzglmtiyrzygpkiuthf`, schema
`catalog`, bucket público `catalog-products`. El PR permanece en borrador.

## Fuentes y alcance

- [Issue #12 y comentarios](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/12),
  #43 y #44 consultados el 2026-11-03. Sus informes anteriores no prueban el estado actual.
- Docs `master@e5c8aeac01e9742e12406723cfba3883095cb85b`: rutas y blobs exactos en
  [normative-sources.json](evidence/normative-sources.json). Incluye SPEC-003/004,
  SPEC-010-asociacion-tipo-producto-caracteristica, FLOW-003/004, modelo físico,
  0001, validation, OpenAPI, AsyncAPI, DEC-F, trazabilidad, matriz intermodular,
  acuerdo G2 del 2026-11-02 y procedimiento/ejecutor `datos/deploy`.
- DEC-F-001: solo SKU vendibles tienen perfil/preparación física; DEC-F-006:
  Pricing conserva autoridad sobre precios; DEC-F-009: reintento idéntico,
  divergencia aborta; DEC-F-012: fuentes/versiones y estados independientes.
- Backend: AGENTS.md completo, RESOLUCION-PUNTOS-4-9, schema/servicio/tests y las
  seis guías Oracle requeridas. No se modifican endpoints ni modo demo.
- Archivos nuevos únicamente bajo `apps/catalog-svc`. El issue no amplía permisos
  sobre scripts compartidos. Los cambios locales preexistentes en
  `scripts/seed/mcp/catalog/{001,006,README,007..012}` y el certificado sin seguimiento
  se conservan, quedan fuera del commit y no forman evidencia de este paquete.
  En particular, las dimensiones sintéticas de esos archivos no se reutilizan.
- Base Backend al iniciar: `f995307b7f704f24c5ef0fb5806518947dc41c07`;
  master `eeaf39ad666d7bc5a11c0b2a80d9c8c4b0016414`: poma 0 adelante/1 atrás.
  No hubo merge, rebase ni sincronización masiva. El diff nuevo es DATA-002.
- Compatibilidad de esta corrección: `origin/master@1bf615e9cae70b93eeec9fcfec862d450e9ebfb9`
  consultado mediante fetch; GitHub informa MERGEABLE/CLEAN. Se conserva `poma`
  sin merge, rebase ni force push. La CI del nuevo SHA se verifica aparte en la PR.

## Auditoría real y diferencias

Lectura MCP del 2026-11-03 desde 22:38 UTC (17:38 Lima). PostgreSQL remoto 17.11.
[Snapshot](evidence/supabase-readonly.json), [conciliación](evidence/reconciliation.json)
y [preflight de imágenes](evidence/image-preflight.json). `audit-readonly.sql`
permite repetir la extracción administrativa; sus joins/lecturas de Taxonomy
son auditoría, no una integración runtime entre bounded contexts.

| Componente | Lectura real |
|---|---:|
| Productos / variantes / identidades | 20 / 51 / 71 |
| SKU potencialmente vendibles / bases no vendibles | 55 / 16 |
| Imágenes producto / variante / objetos Storage | 3 / 51 / 23 |
| Perfiles físicos / preparaciones registradas | 0 / 0 |
| Estados productos / variantes | 20 BORRADOR / 51 BORRADOR |
| Ledger | Solo 0001_create_catalog.sql |

`publicado_alguna_vez` y `sku_barcodes` ausentes en el destino. 0001 tiene checksum
`5d90c3e3b3cc87c5287c93076830fb95164261ceda493b2a6ea6e6247ab12662`.
La fixture 0001 coincide con el blob normativo
`5861536e31b2eb0ccb94d8ad2a4e10f4e792d6d2`.

Las 12 comprobaciones de `004_postcheck_readonly.sql` se repitieron contra
Supabase: **12 PASS** (15 productos, 45 variantes, 48 SKU vendibles del lote).
La comparación offline de campos del manifiesto, combinaciones, imágenes y
atributos no presenta diferencias; referencias maestras activas y valores de
lista corresponden a sus características. La conciliación separa los 15 UUID
originales y los cinco productos adicionales, sin regenerar identidades.

Los doce `valor` JSONB null de atributos LISTA conservan valor_id activos y
correctos de Taxonomy; no son valores desconocidos ni requieren normalización
contractual. `attribute-review.json` los documenta por ID. Se tratan aparte las
ocho filas faltantes de `product_identifying_characteristics` y los dos atributos
obligatorios ausentes en Nike Pitch. Las asociaciones tipo/característica de
Taxonomy están activas; no confundirlas con las ocho relaciones locales faltantes.

`fn_assert_product()` real exige imagen de padre aun con imágenes de variantes;
los 16 padres carecen de ella. Identidad, correspondencia padre/variante y claves
identificadoras derivadas no presentan inconsistencias en la auditoría.

## Operaciones independientes propuestas

| Paquete | Escrituras máximas en primera ejecución | Aprobación |
|---|---|---|
| A — siete vinculaciones | 6 UPDATE exclusivamente `variant_images.url`; 1 INSERT `product_images` Nike Pitch | Pendiente |
| B — portadas | 12 INSERT `product_images`, incluido RUNx acreditado por SHA-256 oficial | Pendiente de ejecución; cuatro portadas adicionales separadas |
| C — barras 0002 | DDL ya existente; cero códigos inventados | Pendiente, proceso de migración oficial |
| D — publicación 0003 | DDL ya existente; históricos NULL, nuevos false | Pendiente, después de 0002 |
| E — perfiles académicos | 55 INSERT `sku_physical_profiles`, solo filas ausentes; reintento idéntico sin UPDATE | Estimaciones admitidas; decisión artículo/embalaje y ejecución pendientes |

`image-map.json` fija SKU, producto, variante, image_id, URL anterior/nueva,
archivo, object_id y eTag exactos de A. Incluye Nike Pitch
`abab3400-46eb-58f7-78d5-8204418b60d9`, SKU `NIK-PITCH-05`.
El INSERT omite `id`: usa `gen_random_uuid()` de la tabla. Los cinco objetos
nuevos existen; metadatos positivos y MIME de imagen comprobados. La matriz
reference-image-review conserva lectura HTTP, hashes y referencias comerciales.
La clasificación general es ASOCIACION_POR_NOMBRE_Y_SKU: los nombres manuales
identifican producto/modelo/color, sin acreditar inspección visual individual.

`cover-map.json` fija doce padres, imagen/variante fuente del mismo modelo,
fuente comercial histórica, archivo, object_id y eTag. Reutiliza URL sin copiar
objetos. La matriz histórica `005` conserva su clasificación original. Los cuatro
padres adicionales quedan fuera del SQL B como `PENDING_SEPARATE_PROPOSAL`.
RUNx conserva Negro: adidas denomina JD9558 Black / White / Black. Su imagen
almacenada y la enlazada desde la página oficial tienen exactamente el mismo
SHA-256; evidence/jd9558-image-correspondence.json registra URLs, fecha, bytes y
método. Se retira el supuesto conflicto por tejido jaspeado y se reincorpora
su portada solo a la propuesta offline B. Una foto compartida por tres tallas
no acredita inspecciones individuales, talla ni autenticidad. image_conflicts
queda vacío; las cuatro portadas adicionales siguen separadas.

Cada paquete tiene preflight, aplicación propuesta y postcheck independientes.
Los UPDATE aceptan solo el placeholder exacto o el resultado idéntico ya aplicado;
cualquier ID/SKU/URL/objeto/eTag divergente aborta toda la transacción. Se preservan
las imágenes existentes. Pitch admite ausencia o exactamente una fila equivalente
principal/posición 0; otras situaciones requieren conciliación. Portadas conserva
una portada existente con la URL comercialmente mapeada y objeto válido; otras
portadas requieren conciliación técnica. No sobrescribe imágenes ni amplía el
mapeo de modelos. Bloqueos de tabla impiden duplicados por concurrencia de escritores.

Después de A: cuatro imágenes de producto globales; el lote original sigue con
tres y el `004` histórico continúa válido. Después de B: 15 imágenes producto
globales (16 si A también se aprobó); el lote original tiene 15, por lo que la
expectativa histórica exacta de tres deja de aplicar. **No se modifica `004`**:
`covers-postcheck.sql` verifica los doce padres y sus fuentes; las pruebas
comparan los registros originales completos, las identidades y estados.

## Perfiles y activación

El usuario proporcionó `DATA002_Perfiles_Fisicos_55_SKU_Carga_Academica_Codex.xlsx`
y comunicó la autorización de Marco para estimaciones creíbles de uso académico.
La instrucción del chat es la autorización de uso de datos; las notas de la hoja
`INSTRUCCIONES` se conservan como contenido documental, no como órdenes ejecutables
ni autorización independiente para Supabase. No se ejecutan macros ni fórmulas.

Fuente binaria intacta: `sources/physical-profiles-academic.xlsx`, SHA-256
`ed169cef1538cf01cc665c43ebc8bde05e2e584514bb07ac51e4fc254bac2a6e`.
`sources/physical-profiles-extracted.json` conserva las 55 filas de `CARGA_55!A2:R56`,
los decimales exactos, las cuatro etiquetas `origen_*`, fuente, presentación,
observaciones y hojas de respaldo. `extract-profiles.py` usa OpenXML de solo
lectura y rechaza fórmulas en SKU/medidas, duplicados y números no positivos/finitos.
Puede repetirse con Python 3 y la ruta del Excel original; no modifica el libro.

`profile-manifest.json` relaciona exactamente 51 variantes y cuatro productos
simples con sus `sku_identity_id`, `product_id` y `variant_id` existentes. La
lectura adicional `evidence/profiles-readonly.json` del 2026-11-03 23:31:36 UTC
confirma 71 identidades, cero perfiles y cero preparaciones. `profiles-proposed.csv`
mantiene trazabilidad por fila. `physical-profiles.csv` muestra las medidas
propuestas y `STRUCTURAL_READY_SEMANTICS_PENDING`, con `perfil_existe=false`; no afirma
persistencia ni activación. La plantilla vacía queda solo para futuras revisiones.

Los valores se trasladan sin redondeo ni sustitución a **peso_kg, largo_cm,
ancho_cm y alto_cm**, kg/cm. La fuente mezcla `ESTIMACION_ACADEMICA` y
`PUBLICADO_NO_HOMOLOGADO` (213 y siete valores respectivamente, entre las 220
medidas). Algunas presentaciones incluyen bolsa o caja; se
conserva exactamente el criterio académico del Excel. Este criterio no coincide
con el perfil intrínseco normativo: 51 presentaciones incluyen embalaje y cuatro
balones no. La propuesta preferida conserva este archivo como simulación logística
y requiere una fuente intrínseca separada; la alternativa exige excepción académica
delimitada por Marco/Arquitectura y homologación G2 si le afecta. No se incorpora
una columna de volumen: se deriva cuando corresponda. Padre con variantes no
tiene perfil ni stock propio.

Paquete E: `profiles-preflight.sql`, `profiles-apply-proposed.sql` y
`profiles-postcheck.sql`. El preflight clasifica las 55 filas como READY,
ALREADY_APPLIED, PROFILE_CONFLICT, OWNER_CONFLICT o INVALID_MEASURE. Aplicación
transaccional con owner, locks, timeouts y barrera de decisión semántica: máximo
55 INSERT únicamente en
`catalog.sku_physical_profiles(sku_identity_id,peso_kg,largo_cm,ancho_cm,alto_cm)`.
El ID del perfil usa el default de la tabla. Un perfil idéntico conserva UUID y
timestamps; uno divergente o parcial aborta el lote completo, sin sobrescritura.
Revalida cada identidad, propietario, unidad vendible y las cuatro medidas.
Productos, variantes, SKU, imágenes, preparaciones y mensajería se preservan.
E puede aprobarse de manera independiente de las migraciones C/D: usa la tabla
de perfiles existente del esquema base, también probado sin 0002/0003.
El SQL no configura `catalog.data002_physical_semantics`: sin decisión aprobada
falla con DATA002_PHYSICAL_SEMANTICS_NOT_APPROVED. La simulación que lo habilita
vive únicamente en las pruebas desechables; no concede autorización compartida.

`activation-blockers.csv` separa por SKU los perfiles ausentes, imagen,
atributos y relaciones identificadoras. Para perfiles indica
PENDING_SEMANTIC_DECISION_AND_LOAD.
Todos necesitan Pricing real por producto
e Inventory real por SKU vendible. Un padre requiere además variante ACTIVA;
ninguna lo está. No se fabrica `COMPLETED`, stock, mensajes ni operaciones.
BORRADOR y corrección de imágenes no equivalen a habilitación comercial en ningún canal.

## Revisión de migraciones existentes

0002 conserva D-CAT-01..04: FK interna a sku_identity, varios códigos por SKU,
unicidad global aun retirados, código/propietario inmutables, retiro lógico y
rechazo de bases de padres. No exige códigos para activar. No se crea versión equivalente.

0003 añade BOOLEAN nullable **antes** de DEFAULT false: conserva NULL en los 20
históricos, sin backfill. El trigger fuerza false al insertar, true en transición
BORRADOR→ACTIVO, rechaza true→false/NULL y cambios manuales NULL→false. El rollback
revierte indicador/activación juntos. `catalog.schema.ts` admite NULL, y el guard
de `catalog-mutation.service.ts` exige `=== false` para corregir tipo, además de
las otras precondiciones Q-06. Las migraciones no se modificaron.

El modelo físico histórico todavía enumera el esquema base y restricciones Q-06
anteriores; SPEC-003 vigente describe la decisión nueva. Esta diferencia documental
no certifica que el DDL candidato esté aplicado. Marco/Docs debe consolidar el
historial oficial antes de ejecución. `migrations-preflight.sql` y
`migrations-postcheck.sql` permiten revisar estructura, ledger, triggers y permisos.

## Procedimiento propuesto para aprobación

1. Marco aprueba explícitamente destino, operaciones A/B/C/D/E elegidas, SHA del
   PR, archivos y SHA-256 de `SHA256SUMS`, responsable, ventana y recuperación.
   Merge, acceso a Supabase o este issue no son autorización.
2. Repetir auditoría y preflight en destino. Para A: seis READY o
   ALREADY_APPLIED y Pitch true. Para B: doce fuentes documentadas, incluido RUNx; los
   cuatro modelos fuera de propuesta siguen excluidos. Para E: 55 READY o
   ALREADY_APPLIED, sin conflictos, mapeo 51 variantes + 4 simples y decisión
   documentada sobre artículo/embalaje. READY estructural no cierra esta decisión.
   Abortar ante conflicto; no acomodar datos para forzar coincidencia.
3. Confirmar `po_catalog_owner` y propietario real del schema. Los SQL A/B
   requieren SELECT autorizado en metadata `storage.objects/buckets`; comprobar
   permisos efectivos antes. No se incluye ni se solicita GRANT automático.
   El administrador se encarga de autorizar y gestionar Storage. Este paquete
   no cambia privilegios, RLS ni propietarios; no se cambia de rol a escondidas.
4. C/D mediante el `datos/deploy/migrate.py` oficial, conexión directa o session,
   TLS verify-full y login miembro solo del owner. Orden 0001 existente → 0002 →
   0003. El ejecutor verifica SHA-256 UTF-8 sin BOM/LF, secuencia, advisory lock,
   ledger y una transacción por versión. No usar pooler transaction/bootstrap/MCP
   apply_migration ni registrar versiones manualmente. Backend tiene 0001 en
   fixture y 0002/0003 en migrations; no apuntar el ejecutor directamente a esa
   carpeta incompleta. Marco/Docs debe incorporar los candidatos idénticos en
   el historial oficial o aprobar un bundle temporal verificable con el 0001
   normativo intacto y ambos candidatos exactos, sin nuevo historial permanente.
5. A/B/E son cargas de datos independientes del migrador DDL: ejecutar
   cada archivo completo con `psql -X -v ON_ERROR_STOP=1`, preservando BEGIN/COMMIT,
   timeout de locks 5 s y de sentencia 30 s. No ejecutar fragmentos sueltos.
   No congelar Storage durante esta tarea; en ejecución aprobada, impedir
   reemplazos concurrentes de los objetos o revalidar eTag/HTTP al finalizar.
6. Guardar evidencia antes/después y resultados por operación/SHA. Ejecutar
   postchecks A/B/E y, solo tras C/D, postcheck de migraciones. E exige 55 filas
   coincidentes en las 220 medidas, UUID de perfil registrados, cero perfiles
   en padres con variantes y ninguna modificación ajena. Esperado inicialmente:
   cero códigos y 20 históricos NULL; nuevos inserts false. Las comprobaciones
   que escriben pertenecen exclusivamente al entorno aislado.
7. Fallo antes de COMMIT: rollback completo. Después de COMMIT no hay reversión
   automática: conciliar IDs y valores exactos con evidencia del operador y nueva
   aprobación. Propuesta A: restaurar seis URLs solo si conservan los valores
   aplicados; retirar únicamente la fila Pitch cuyo UUID consignó el postcheck,
   si sigue idéntica y sin ediciones posteriores. B: retirar solo UUID nuevos
   registrados por el operador, sin tocar portadas previas. E: un fallo revierte
   todo; después de COMMIT cualquier reversión requiere aprobación nueva y una
   conciliación exacta de UUID/medidas/fecha, conservando perfiles anteriores al
   lote. No se incluye DELETE automático ni borrado de perfiles existentes.
   No borrar productos,
   variantes, identidades ni Storage. C/D: preferir corrección aditiva; no DROP ni
   borrar historial publicado/códigos. La recuperación remota no está ensayada.

`SHA256SUMS` registra archivos operativos y ambas migraciones; recalcular hashes
si cambia cualquier propuesta antes de solicitar autorización.

## Pruebas y estados independientes

Generación: `node apps/catalog-svc/data002/prepare.mjs` (offline).
Prueba aislada: `node --test apps/catalog-svc/data002/isolated.test.mjs`, con
`DATA002_PG_BIN` hacia un PostgreSQL completo o Docker `postgres:17`. Se crea una
instancia sin secretos en puerto aleatorio de loopback y una base por caso;
se detiene al terminar. Nunca acepta URL de Supabase. El wrapper
`test/data002.e2e-spec.ts` incorpora la suite al comando E2E existente.

La suite reutiliza la fixture 0001 y las migraciones existentes. Comprueba estado
previo, seis sustituciones, Pitch, reintento, conflictos/rollback, objetos ausentes
o reemplazados, portadas existentes/faltantes, preservación de identidades,
perfiles solo vendibles, 0002/0003 y ausencia de alteraciones de otros schemas.
Datos físicos y preparaciones ficticias solo aparecen en el caso desechable
que prueba activación. El paquete E contiene las medidas académicas del Excel,
sin fabricar preparaciones; ninguna propuesta fue ejecutada en Supabase.

Resultados finales, SHA y CI se registran en el PR. Una CI anterior no acredita
este cambio. Integración autenticada, homologación externa y despliegue:
**NO EJECUTADOS** por esta tarea.

Validación local: unitarias globales 2031 PASS / 56 SKIP; schema 16 PASS;
DATA-002 PostgreSQL 17.11 ampliado a **25 PASS**, incluidos los 12 casos nuevos
de perfiles, medidas exactas, idempotencia, conflicto/rollback y entradas inválidas;
typecheck, lint,
format:check, build:catalog-svc y diff --check PASS. Un primer intento de schema
falló por EPERM de temporales del sandbox; pasó al ejecutar con acceso normal.
El PostgreSQL 16 instalado carece de share/postgres.bki; se utilizó distribución
portátil oficial 17.11 en temporales, sin instalar servicios ni cambiar el repo.
El primer arranque portátil bloqueó pipes de pg_ctl en Windows; se corrigió
stdio del proceso y los casos pasaron. La primera prueba de perfiles detectó una
ambigüedad entre la variable PL/pgSQL y el alias del conteo: se corrigió la
consulta de alcance y los 25 casos pasaron. No quedan esos fallos en el código final.

E2E global inicial: **FAIL**, 909 PASS / 284 SKIP; una suite Bulk falla al iniciar
Docker con ENOENT porque no está instalado. Es una limitación de validación fuera
del ownership de Catálogo. No se modificó ni eliminó esa prueba. La repetición
aplicable usa `--exclude apps/bulk-svc/test/bulk-postgres-outage.e2e-spec.ts`:
**909 PASS / 283 SKIP, 32 suites PASS y 17 SKIP**. No confundir esta exclusión
con PASS integral del monorepo. Una repetición intermedia detectó una aserción
demasiado amplia al añadir UUID al postcheck; se corrigió para validar filas
SKU/resultado exactas, y la prueba enfocada y repetición global aplicable pasaron.

| Estado operativo | Owner | Operación / desbloqueo verificable |
|---|---|---|
| IMPLEMENTAR_AHORA | Poma | Paquete offline y pruebas aisladas |
| BLOQUEADO_ESPECÍFICO | Marco + owner BD | Escritura compartida: aprobar destino/SHA/hashes/proceso/permisos |
| IMPLEMENTAR_AHORA | Poma | 55 perfiles académicos completos; preparar y probar carga E según Excel aportado |
| BLOQUEADO_ESPECÍFICO | Marco + owner BD | Carga E: aprobar destino, 55 identidades, valores/hashes exactos y procedimiento de ejecución |
| BLOQUEADO_ESPECÍFICO | Marco/Arquitectura + G2 si aplica | Artículo/embalaje: fuente intrínseca separada o excepción académica delimitada antes de solicitar carga |
| BLOQUEADO_ESPECÍFICO | Poma + Marco | Ocho identificadores locales y atributos Pitch: propuesta separada; los doce JSON null con IDs válidos no requieren normalización |
| IMPLEMENTAR_AHORA | Poma | RUNx: correspondencia oficial acreditada por SHA-256, Negro conservado y portada reincorporada a propuesta B; cuatro portadas adicionales separadas |
| BLOQUEADO_ESPECÍFICO | Vera/Pricing + Taco/Inventory + Poma | Preparación: ejecutar flujo autorizado y confirmar mensajes reales por producto/SKU/operation_id |
| BLOQUEADO_ESPECÍFICO | Marco/Docs | Consolidar 0002/0003 y modelo físico en historial normativo antes de aplicar |
| BLOQUEADO_ESPECÍFICO | Castilla/entorno CI | E2E integral Bulk: disponer de Docker y ejecutar bulk-postgres-outage sin exclusión |

Estado global: **PARTIAL**; entrega para revisión, no cierre de DATA-002.
