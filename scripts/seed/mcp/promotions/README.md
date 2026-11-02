# DATA-005: preparación de maestros de Inka Athletics

## Propuesta local de locking — revisión pendiente

Marco aceptó la preparación interna y encargó a Axel/López validar una solución
mínima; no autorizó cargas ni grants compartidos. Ver
[PROPUESTA-LOCKING-SEED.md](PROPUESTA-LOCKING-SEED.md) y su runner
`node scripts/seed/mcp/promotions/test/seed-locking-proposal.mjs`.
La candidata se probó solo en PostgreSQL descartable con login seed restringido:
ACL UPDATE(id) limitada y guard invoker que rechaza toda mutación. Requiere
revisión de López/BD y aprobación específica de Marco; el gate productivo sigue
`SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED`. No es una migración ni un modo apply.

## Correcciones previas al merge — 26/10/2026

Ver [AUDIT-2026-10-26.md](AUDIT-2026-10-26.md) para las regresiones de estados
reales y precios por canal. Productos publicados usan `ACTIVO`; variantes usan
`ACTIVA`. Un SKU simple conserva el estado de su producto `sku_base`. Los flags
de actividad no permiten aceptar `BORRADOR` ni estados inactivos.

El canal solicitado se filtra antes de seleccionar overrides SKU o herencia del
padre. Un override de otro canal no descarta el padre global; uno aplicable que
solo cubre parte de la campaña sigue rechazándose, sin fallback silencioso.

`SHA256SUMS` conserva exclusivamente los tres hashes históricos esperados por
el validador de restauración. El inventario actualizado de scripts y evidencia
está separado en [TOOLING-SHA256SUMS](TOOLING-SHA256SUMS). No se modifica el
validador, el SQL de escritura ni el contenido comercial; continúan los gates
de revisión, canales, permisos seed y carga compartida.

## Auditoría corregida — 24/10/2026

Estado vigente: **`IMPLEMENTADO_LOCAL / INTEGRACION_BLOQUEADA`**. Ver
[`AUDIT-2026-10-24.md`](AUDIT-2026-10-24.md) para referencias reales, decisiones
pendientes, comandos y límites de evidencia. Los cortes del 16/10 que siguen
se conservan como historia; no describen el estado comercial actual.

[`reconciliation-2026-10-24.json`](reconciliation-2026-10-24.json) concilia la
captura MCP de solo lectura de Catálogo, Taxonomía, Pricing, Inventario y los
maestros/permisos de Promotions. [`bindings.review-2026-10-24.json`](bindings.review-2026-10-24.json)
contiene únicamente candidatos existentes, con `BORRADOR`, `active=false`,
`channels=[]`, revisión pendiente y `executable=false`. No es un lote aprobado.

```powershell
node scripts/seed/mcp/promotions/reconcile.mjs scripts/seed/mcp/promotions/supabase-readonly-2026-10-24.json
node scripts/seed/mcp/promotions/reconcile.mjs scripts/seed/mcp/promotions/supabase-readonly-2026-10-24.json --bindings
```

La consulta reproducible es `reconcile-readonly.sql`: una transacción
`REPEATABLE READ READ ONLY` que termina en `ROLLBACK`. Se ejecutó por MCP;
`reconcile.mjs` solo lee una captura local y emite JSON. No ejecuta SQL ni
autentica el origen de archivos entregados por un tercero. Los hashes de
objetos son SHA-256 de `JSON.stringify`; `SHA256SUMS` registra bytes de archivo.
Ninguno sustituye una recaptura/revisión de procedencia por los owners.

El generador ahora reconoce precio padre cuando no hay override aplicable,
precedencia SKU y luego canal/global, cancelación y fin abierto (`null`).
Mantiene rechazo de ambigüedad y overrides parciales: exige una vigencia
única para toda la campaña. Los precios de origen no se duplican ni cambian.
Un precio global no acredita canales; los bindings `REVIEW` exigen evidencia
documental explícita por canal. Esa evidencia solo se valida estructuralmente.

La evidencia nueva de PostgreSQL está en `test/evidence/isolated-2026-10-24.json`;
la del 16/10 se conserva íntegra. El runner fecha sus nuevas capturas en
America/Lima para evitar sobrescribir evidencia histórica.

Revalidación sobre `cueva` sincronizada con `master` (16/10/2026):
[`REVISION-MASTER-2026-10-16.md`](../../../../apps/promotions-svc/REVISION-MASTER-2026-10-16.md).
Las 31 pruebas offline de seed/DATA/restore y el ensayo PostgreSQL descartable
pasaron. `test/evidence/isolated-2026-10-16.json` registra la ejecución nueva.
Se mantienen los bindings reales incompletos, las filas inactivas, cero
persistencia compartida y el bloqueo específico del rol seed por locks de triggers.

Issue #15. Owner: Axel Cueva. Rama `cueva`. Fecha: 2026-10-16, America/Lima.
Estado: `IMPLEMENTAR_PARCIAL`. Modo real: lectura MCP y diseño; sin ensayo ni
persistencia compartidos. La ampliación local de preparación y pruebas se
documenta al final. No se modificaron schemas, grants, migraciones ni datos
compartidos.

## Fuentes y baseline

Docs `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`: modelo físico de Promotions,
SPEC-005/006/007, DEC-F-007/008/009/012 y guía PostgreSQL de desarrollo local.
`baseline-2026-10-16.json` conserva columnas, constraints, triggers y permisos
declarados consultados, y los conteos nuevos de las seis tablas maestras propias
y tres proyecciones propias: **todos cero**. No se consultaron schemas ajenos.

La consulta se ejecutó con el MCP como `postgres`, no con el login individual.
Los permisos SELECT/INSERT/UPDATE/DELETE declarados de `promotions_dev_login`
se comprobaron como metadatos para las seis tablas maestras; eso no demuestra
una conexión autenticada con ese login. En la revisión inicial faltaba el broker
y el CA local no existía. En la verificación posterior, el CA ya valida y se
configuró un broker real de desarrollo ligado a 127.0.0.1; el arranque de
liveness pasó. También pasó la conexión PostgreSQL del login configurado,
con TLS autorizado, identidad/base esperadas y BEGIN READ ONLY/ROLLBACK.
Los seis conteos propios siguieron en cero. Evidencia reproducible:
`apps/promotions-svc/dev/check-local-database.mjs` y
`apps/promotions-svc/test/evidence/local-postgres-2026-10-16.json`.
No se imprimieron valores ni se modificaron datos o permisos; no se infiere
una auditoría completa de membresías ni homologación externa.

## Borrador comercial

`inka-athletics-draft.json` contiene IDs propios estables, orden propuesto y
filas propuestas separadas del diseño pendiente de recomendaciones:

- Semana Running: 10 % sintético sobre referencias running por vincular,
  automática, inactiva, una semana, sin combinación con otros beneficios.
- Entrena en Equipo: 5 % sintético mediante cupón demo inactivo, dos semanas,
  20 usos globales y uno por cliente, sin usos precargados ni compra simulada.
- Cross-sell de zapatillas running con medias deportivas y de balón de fútbol
  con accesorio de entrenamiento. Se especifica la selección comercial, pero
  **no** se fabrican IDs de origen/candidatos.

Los descuentos son propuestas pendientes de contrastar con los precios de las
referencias finales. Todas las campañas/cupones están INACTIVO. No se promete
beneficio real ni elegibilidad actual.

**El borrador no es ejecutable.** `promotion_scopes`, `recommendation_rules` y
`recommendation_items` siguen sin filas definitivas. Los triggers de completitud
impiden insertar promociones sin alcance y reglas sin candidatos. No se eluden
con referencias ficticias ni sembrando proyecciones.

No se encontraron manifiestos de negocio en el `master` Backend consultado
`24227527c632be4f3b8de612954328904ea57de0`. Las ramas remotas `poma` y `vera`
consultadas apuntaban a `42b5143db14d2722e6f37d8a4ef41f02eded03b5`, sin manifiestos.
Los comentarios de #12/#13 son backlinks de coordinación, no publicaciones de
referencias/precios. Esto describe las fuentes consultadas, no toda actividad
posible de los otros owners.

## Dependencias específicas

| Owner                         | Operación                                    | Desbloqueo verificable                                                                                                                                            |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gabriel Poma / Catálogo / #12 | Alcances de campaña y recomendaciones        | Manifiesto/API versionados con IDs/SKU vendibles de las familias elegidas y sus estados.                                                                          |
| Leonardo Vera / Pricing / #13 | Coherencia económica y elegibilidad          | Precios, canales y vigencias publicados para las referencias elegidas.                                                                                            |
| Axel / configuración local    | Autenticación PostgreSQL con el login propio | Verificada en solo lectura: TLS autorizado, login/base esperados y SELECT de los seis maestros propios. No acredita integración comercial ni aprobación de carga. |
| Marco / owner Promotions      | Ensayo en compartido                         | Autorizar alcance, tablas y destino del ensayo; revisar cuerpos/efectos de triggers y garantizar transacción completa.                                            |
| Marco / owner Promotions      | Persistencia                                 | Tras completar referencias y validaciones, aprobar SQL/manifiesto/hash y destino exactos; baseline fresco, comparación de conflictos, repetición y postcheck.     |

La preparación no espera homologación G1/G4/G5/G7. La frontera de referencias
pendientes no paraliza el diseño interno de Promotions. El registry del runner
alternativo no es un requisito para esta preparación MCP.

## Reproducción y control

```powershell
node scripts/seed/mcp/promotions/validate-draft.mjs
node --test scripts/seed/mcp/promotions/validate-draft.test.mjs
```

El validador comprueba decimales exactos sin redondear porcentajes, períodos,
identidades, unicidad, política de combinación, límites y estado inactivo.
Un PASS acredita coherencia interna del borrador: el resultado conserva
`insertable_batch=NO`, referencias pendientes y cero escrituras compartidas.
No acredita coherencia económica con precios ni referencias publicadas.

`trigger-body-review-2026-10-16.json` añade una revisión posterior de los cuerpos
de seis funciones de triggers de maestros obtenidos con SELECT/MCP. Documenta
alcance, hashes de definición y límites; no altera el baseline anterior ni
autoriza un ensayo. No se observaron efectos externos en esos cuerpos revisados.

`SHA256SUMS` registra los hashes de bytes exactos de los JSON de esta entrega.
Vincular referencias cambia el contenido: generar una nueva versión y hash,
revisar conflictos y obtener las autorizaciones del lote final. No reescribir
evidencia de un lote aplicado ni interpretar PREPARADO como ROLLBACK o COMMIT.

Los metadatos de preparación no son DTOs ni contratos públicos. La entrega
inicial no incluía SQL de carga; la ampliación siguiente incorpora un preview
para revisión. No se incluyen arrays en producción, cupón consumido, ventas,
inbox/outbox, receipts, proyecciones, datos de inventario ni schema_migrations.

## Ampliación local: generador del lote y comprobación real de restricciones

`prepare-batch.mjs` agrega una preparación offline de las seis tablas maestras.
El borrador original y sus tres hashes históricos se conservan sin cambios.
`bindings.template.json` está deliberadamente incompleto: no contiene IDs de
Catálogo, precios ni aprobaciones inventados. Ejecutarlo falla antes de emitir
SQL. Los ejemplos sintéticos completos viven exclusivamente en
`test/support/bindings.mjs`; nunca son fixtures aprobados del restore.

El formato de bindings es un documento local de revisión, **no un contrato de
Catálogo/Pricing**. Transcribir desde fuentes publicadas y registrar su referencia
inmutable/hash; el generador no descarga esas fuentes ni autentica su procedencia.
La evidencia cualitativa y el reviewer son referencias documentales a revisar,
no una firma ni una aprobación de Marco. Nunca completar estos campos con
confirmaciones inexistentes.

Campos para completar con fuentes finales:

- `catalog.products`: `product_id`, estado observado y `active` por producto.
- `catalog.skus`: `sku`, `product_id`, estado, `active`, `channels` explícitos;
  `channel_evidence` por canal en documentos `REVIEW`. Nunca inferirlos del precio global.
- `pricing.prices`: exactamente un objetivo `sku` o `product_id`, `channel_id`
  (o null global), `currency`, `amount` decimal exacto, `valid_from` UTC y
  `valid_until` UTC o null. Conservar IDs/versiones, oferta y cancelación de la
  fuente real; las referencias de prueba permanecen exclusivamente en tests.
- `catalog.source` y `pricing.source`: `reference` y SHA-256 de la fuente publicada.
- `campaign_scopes`: SKU seleccionados para cada ID propio de campaña. Este
  generador prepara alcances por SKU; no convierte un alcance de producto en
  una foto de sus variantes. Un alcance de producto requeriría revisión aparte.
- `recommendations`: en el orden del diseño original, producto de origen y
  lista ordenada de productos complementarios, nunca SKU automático.
- `review`: reviewer y evidencia de revisión humana del rubro deportivo,
  coherencia running/entrenamiento/fútbol, complementariedad y naturaleza demo.

Comprueba referencias presentes/activas y canal; descuentos exactos y resultado
positivo; cobertura completa de vigencia con precio global o de canal; rechaza
precios ambiguos y overrides parciales. Esa comprobación conservadora exige un
precio que cubra toda la campaña: si hay varios períodos legítimos, reconciliar
el lote/fechas en revisión. No inventa agregación de precio/disponibilidad por
producto para recomendaciones (D-REC-01/02 siguen pendientes).

Las filas se generan inactivas, con IDs propios deterministas, alcances,
políticas y candidatos completos. El hash de contenido incluye filas, bindings,
fuentes y revisión. La salida mantiene `executable=false`, las aprobaciones
nulas y el estado de procedencia pendiente de revisión. Completar bindings no
prueba autenticidad, aprobación, ensayo ni carga. `ISOLATED_TEST` marca de forma
explícita los datos de prueba y no habilita ningún destino.

```powershell
# Con un archivo de bindings completos/revisados; no ejecutar la plantilla vacía.
node scripts/seed/mcp/promotions/prepare-batch.mjs <archivo-bindings-revisado.json>
node scripts/seed/mcp/promotions/prepare-batch.mjs <archivo-bindings-revisado.json> --render-rollback
node --test scripts/seed/mcp/promotions/prepare-batch.test.mjs
node scripts/seed/mcp/promotions/test/isolated.mjs
```

Los argumentos entre `<...>` son rutas a sustituir, no comandos literales de
PowerShell. El generador solo imprime JSON o SQL para revisión: no lee `.env`,
no conecta a una BD y no tiene modo apply/commit. Rechaza argumentos adicionales.
El SQL usa nombres fijos de tablas/columnas, valores escapados con tipos,
`INSERT ... ON CONFLICT DO NOTHING` y comparaciones exactas posteriores;
un conflicto por PK o clave natural y un hijo adicional abortan, sin UPDATE.
Las constraints diferidas se comprueban antes del rollback y tras la segunda
pasada. Incluye conteos/huellas de columnas comerciales de los seis maestros
antes, durante y después; comparar baseline y postcheck como parte del ensayo
autorizado. Esas huellas no son una auditoría exhaustiva del schema.

### Dependencia específica encontrada: locks de los triggers

El ensayo descartable reproduce los grants SELECT/INSERT y dos helpers invoker
de INFRA #1 para `po_promotions_seed`, sin concederle UPDATE, DELETE, TRUNCATE,
CREATE ni acceso a tablas técnicas. Los INSERT de `promotion_scopes` y
`recommendation_items` fallan con SQLSTATE **42501**: `fn_lock_parent` ejecuta
`SELECT ... FOR UPDATE` sobre el padre, lo que necesita privilegio UPDATE.
`fn_guard_coupon` también toma un lock de ese tipo sobre su promoción.

El preview detecta esa condición antes de insertar y aborta con
`SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED`. No concede UPDATE ni usa otro rol para
eludirla. **Owner: Marco + responsable de BD/Promotions (Axel, revisión de López).
Operación: insertar maestros dependientes con rol seed. Desbloqueo: una solución
de permisos/locking revisada, compatible con la política append-only, autorizada
expresamente y comprobada con el rol restringido.** No se modifican grants,
funciones ni migraciones aplicadas desde DATA #15.

El mismo SQL de filas se verifica por separado como `po_promotions_owner`
**solo en el contenedor descartable**. Demuestra mapping, constraints,
conflictos e idempotencia; no demuestra permiso del seed ni autoriza usar el
owner en Supabase. Este bloqueo no impide continuar preparación/pruebas locales.

### Evidencia del ensayo aislado

`test/isolated.mjs` crea un solo PostgreSQL por suite ligado a loopback, verifica
el contexto Docker local y elimina únicamente su propio contenedor al terminar.
Reutiliza las cuatro migraciones oficiales sin cambiarlas, verifica sus Git
blobs del commit normativo y utiliza un puerto/contraseña efímeros. Si no hay
copias en caché, intenta leer las fuentes del commit fijo; no infiere un modelo.
No usa la base compartida, credenciales privadas, broker ni otros servicios.

Resultado en `test/evidence/isolated-2026-10-16.json`: PostgreSQL 17.11; 11 filas
por pasada distribuidas en los seis maestros; repetición sin tocar timestamps;
conflictos por contenido, código duplicado con ID diferente e hijos adicionales
rechazados; CHECK/FK/completitud/autorrecomendación rechazadas; texto con SQL
conservado literalmente. Se conserva además un agregado preexistente de prueba
con sus tres filas. El rollback conserva todos los datos maestros y
operativos del contenedor y la estructura de columnas. Las consultas generadas
de baseline/postcheck también se ejecutaron y coincidieron tras rollback.
La evidencia registra hashes SHA-256 del tooling normalizado a LF y del contenido
del lote sintético, separados de los tres hashes históricos. El rol seed falla como
se describe arriba. La prueba con owner local no se presenta como carga seed.

Estado separado: preparación interna y pruebas aisladas **PASS**; referencias
reales y revisión comercial pendientes; ensayo seed compartido **NO EJECUTADO**;
persistencia **NO EJECUTADA**; aprobación/merge/cierre pendientes. El plan #112
conserva cero entradas ejecutables y no incorpora los datos sintéticos del test.
