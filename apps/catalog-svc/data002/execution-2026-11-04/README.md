# DATA-002 #12 — ejecución real en Supabase, 2026-11-04 UTC

**A/B/E y los 14 INSERT adicionales: APPLIED_VERIFIED. C/D: BLOQUEADO_ESPECÍFICO.**
Proyecto: `slzglmtiyrzygpkiuthf` (Modulo de Productos y Ofertas, sa-east-1).
Fuente aplicada: Backend `master@5abfffc9b86306df87d19695817aa678588e0341`.
PR #175 fusionada el 2026-11-04 03:48:25 UTC, merge `56e475442e5f10a5d08ffa3daf6c66e500ac5caa`.
Los 52 hashes del paquete fusionado se comprobaron antes de cargar; no se modificó ningún SQL original A/B/E ni el Excel.

## Autorización, excepción y conexión

El usuario solicitó esta ejecución y proporcionó el documento legible en
[authorization-request.txt](authorization-request.txt). Los bytes originales se conservan
en [authorization-request.zip](authorization-request.zip), con SHA-256 registrado
en [authorization-source-sha256.json](authorization-source-sha256.json). Posteriormente respondió expresamente:
**«Sí, autorizar los 14 INSERT adicionales»**: cuatro portadas, ocho asociaciones
identificadoras y dos atributos de Nike Pitch, Talla 5 y familia de color Blanco.
No se atribuye esta autorización a un comentario de Marco que no exista.

La excepción académica logística **ACADEMIC_LOGISTIC_EXCEPTION_APPROVED** se usó
exclusivamente para los 55 SKU de E: 51 presentaciones con bolsa/envoltorio/caja y
cuatro balones sin embalaje. Se conservaron las 220 medidas del Excel, sin restar
tara, recalcular ni sustituir valores. Son referencias comerciales y estimaciones
académicas de presentación logística, sin certificación de medición individual.
Esta excepción no modifica el contrato normativo general ni su ownership.

Los cinco lotes de escritura se ejecutaron mediante el conector Supabase. Cada
llamada contenía el SQL transaccional completo, con SET ROLE po_catalog_owner
explícito; cada script conserva su guard de owner, BEGIN/COMMIT, locks y timeouts.
El lanzador original describía psql; la credencial local catalog_dev_login no
permite SET ROLE po_catalog_owner. Se utilizó el conector seleccionado por el
usuario sin cambiar privilegios. **No se presenta esta ejecución como una
ejecución psql o migrate.py.** Se registraron session_user postgres, rol efectivo
po_catalog_owner y PID del backend. same_backend=true en los cinco lotes.
En E, el GUC se configuró en esa misma llamada/conexión antes del script original
y se restableció después. El rol se restableció al terminar cada lote.

[approved-source.json](approved-source.json), [executed-batches.json](executed-batches.json)
y [executed-query-hashes.json](executed-query-hashes.json) registran fuente, hashes,
sentencias enviadas, ventana y contexto de sesión. No contienen credenciales.

## Cambios exactos

| Tabla | Antes | Después | INSERT | UPDATE | DELETE |
|---|---:|---:|---:|---:|---:|
| catalog.product_images | 3 | 20 | 17 | 0 | 0 |
| catalog.variant_images | 51 | 51 | 0 | 6 | 0 |
| catalog.sku_physical_profiles | 0 | 55 | 55 | 0 | 0 |
| catalog.product_identifying_characteristics | 24 | 32 | 8 | 0 | 0 |
| catalog.product_attribute_values | 6 | 8 | 2 | 0 | 0 |
| **Total** | | | **82** | **6** | **0** |

- A: seis URL placeholder corregidas y una imagen de Nike Pitch insertada.
- B: doce portadas insertadas, incluida JD9558; Negro del catálogo se conserva.
- E: 55 perfiles insertados, 51 variantes y cuatro simples, con sus identidades existentes.
- Adicional autorizado: cuatro portadas de PUM-ULP, Entrada 22, Runfalcon y Revolution;
  ocho asociaciones locales y dos atributos Pitch. Solo se usan objetos e IDs existentes.
  Blanco representa la familia de color aprobada para FZ2636-101 (White / Blue Fury / Glacier Blue).
- Se conservaron las tres imágenes de producto previas y las asociaciones de variante.
  En las seis filas de variant_images cambiaron únicamente URL y updated_at por el trigger.

[mutation-audit.json](mutation-audit.json) contiene los UUID insertados/actualizados.
[initial-snapshot.json](initial-snapshot.json), snapshots por paquete y
[final-snapshot.json](final-snapshot.json) permiten contrastar las filas completas.

## Validación directa posterior

- 20 productos, 51 variantes y 71 identidades **idénticos al snapshot inicial**.
  Todos permanecen BORRADOR. Cero activaciones o preparaciones fabricadas.
- 55 perfiles, 220 valores comparados exactamente mediante Decimal contra la extracción
  original del Excel; postcheck SQL de las 55 filas con comparación numeric: todos true.
  Cero perfiles en las 16 bases no vendibles. UUID de perfil nuevos; identidades preservadas.
- 20 productos con imagen y 51 variantes con imagen. Cero placeholder.
- Cero atributos obligatorios ausentes y cero asociaciones identificadoras faltantes
  en la auditoría administrativa de referencias vigentes.
- Cero referencias LISTA inválidas. Los doce JSON null originales con valor_id válido
  conservan sus filas completas. Los dos atributos nuevos de Pitch también usan valor_id
  activo y valor JSON null permitido; no se normalizan las doce filas anteriores.
- Las 23 fotos responden HTTP 200 y tienen el mismo SHA-256 aprobado antes y después.
  Storage, buckets, archivos, propietarios, privilegios y RLS no fueron modificados.
- Ledger sin cambios: solo 0001_create_catalog.sql. Inbox, Outbox, barreras y activation_checks
  permanecen vacíos. No se ejecutó DML sobre schemas de otros módulos.

[final-quality.json](final-quality.json) y su [consulta readonly](final-quality-readonly.sql)
incluyen los indicadores y las 220 magnitudes en texto numérico.
Los postchecks originales A/B/E se conservaron y se ejecutaron; sus SELECT se agruparon
en un objeto de salida para evitar que el conector descarte resultados intermedios.
Resultado: 6 true y Pitch true; 12 true; 55 true y cero perfiles padre.
Preflight final: 6 ALREADY_APPLIED, 12 EXISTING_VALID_COVER, 55 ALREADY_APPLIED.
El semantic_status estático del preflight original se conserva como evidencia histórica;
la decisión vigente es la excepción explícita y el valor de sesión acreditado en E.

## Pruebas e incidencias

- `node --test apps/catalog-svc/data002/isolated.test.mjs`: **25 PASS / 0 FAIL / 0 SKIP**,
  PostgreSQL local desechable; no ejecuta pruebas contra Supabase.
- `python .../verify-additional-isolated.py`: **4 PASS**. Comprueba 14 INSERT exactos,
  conservación de filas existentes y reintento sin cambios; rollback de las cuatro
  portadas ante conflicto en la última; rollback de las ocho asociaciones y Talla
  si Color Pitch discrepa; rechazo de ambos scripts con rol incorrecto.
- Preflight/postcheck y comparación de snapshots compartidos: PASS; hashes y HTTP: PASS.
- Las pruebas de rollback se realizaron solo en PostgreSQL aislado. No se borraron
  registros ni se ensayó una reversión destructiva en Supabase.
- La primera comprobación psql de rol fue rechazada; no se cambiaron membresías.
  Una consulta readonly de auditoría requirió casts UUID→text al cruzar referencias
  opacas de Taxonomy. Se corrigió la consulta; ninguno de los cinco lotes DML falló.
- No hubo cambios TypeScript, dependencias, contratos o workflows; no se atribuye
  una nueva CI a estos recibos ni despliegue/integración autenticada a la carga SQL.

Los archivos de propuesta y los preflights iniciales se conservan como antecedentes.
Los archivos de texto de esta carpeta usan LF y un único salto final para Git.
Los SQL legibles solo normalizan finales de línea/EOF; executed-batches.json conserva
exactamente las cadenas enviadas, con sus hashes en executed-query-hashes.json.
Las cuatro pruebas adicionales se repitieron tras esta normalización; los resultados
anteriores y sus hashes de fuente también se conservan como antecedente.
El estado definitivo del adicional está en
[additional-execution-status.json](additional-execution-status.json).
Los scripts SQL ejecutados están archivados para auditoría; otra ejecución o reversión
en un entorno compartido exige su alcance/autorización vigente. No hay DELETE de recuperación automático.

## C/D y pendientes separados

**No se aplicaron 0002 ni 0003.** [migrations-review.json](migrations-review.json)
contrasta Docs `80f208978c2c703e2b2d62064112365e7b9e1677` y el ledger real:
0001 tiene SHA-256 `5d90c3e3b3cc87c5287c93076830fb95164261ceda493b2a6ea6e6247ab12662`,
idéntico al normativo. El directorio oficial contiene únicamente 0001; no se creó
un historial alternativo ni una fila manual del ledger.

| Owner | Operación afectada | Condición de desbloqueo |
|---|---|---|
| Marco/Docs | C/D | Incorporar 0002/0003 exactas al historial normativo o aprobar bundle temporal verificable con 0001 intacta |
| Administrador/BD | Ejecución C/D por migrate.py | Proporcionar conexión directa/session TLS verify-full y login autorizado con membresía del owner |
| Pricing/Inventory + Poma | Preparación comercial posterior | Ejecutar los flujos autorizados y confirmar resultados reales por producto/SKU; no simular COMPLETED |

El issue #12 permanece abierto. La carga de datos está aplicada y verificada;
esta evidencia no acredita activación comercial, homologación externa o despliegue Oracle.
