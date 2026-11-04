# DATA-BACK-01 / #112: plan de restauración demo

## Revalidación del 16/10/2026 sobre master sincronizado

Ver [`REVISION-MASTER-2026-10-16.md`](../../apps/promotions-svc/REVISION-MASTER-2026-10-16.md).
El validador y las pruebas offline pasaron nuevamente: dry-run, tres hashes
verificados, cero entradas aprobadas y cero SQL/persistencia. No se cambian el
plan ni los fixtures. El inventario de abajo describe la consulta histórica.
En `master` `5bb832b103f9cca4d0967fecde26c1ebccd05944` ahora existe además
`mcp/taxonomy/001_taxonomy_inka_athletics.manifest.json` con SQL y matriz de su
owner. Su presencia no acredita aprobación exacta para restore ni ejecución.
La reconciliación de ese candidato corresponde a López/Marco; no se ejecuta,
duplica ni incorpora automáticamente. La restauración persistente conserva la
condición de aprobación de contenido/hash, tablas y destino por Marco y owners.

Owner: Axel Cueva, rama `cueva`. Fecha: 2026-10-16, America/Lima.
Alcance: inventario, plan/ledger versionados y dry-run; sin SQL ejecutado ni
escritura compartida. Se reutilizan runner, registry, manifiesto y evidencia de
INFRA #1. No se modifica el runner ni se duplican seeds de otros owners.

## Inventario contrastado

Fuente remota Backend `master` `24227527c632be4f3b8de612954328904ea57de0`,
estructura local existente y preparación propia de DATA #15. DATA #11–#16 y
DATA-VAL #17 conservan su ownership. `dataset.json` es reserva de identidades
en PENDING_OWNER_REVIEW; no es inventario de datos persistidos ni fixture aprobado.

El único fixture demo existente en el runner consultado es
`demo/promotions/001_stock_projection.json`: se excluye del restore comercial
porque es una prueba técnica reversible/no autoritativa. Los directorios
required/demo restantes no aportan fixtures comerciales en esas fuentes.
El borrador propio de #15 tampoco es elegible: sus referencias finales faltan.

`restore-plan.json` registra **cero entradas ejecutables**. Eso es un resultado
del inventario, no un restore exitoso. El plan se puede validar en dry-run,
pero todavía no permite demostrar restauración de un dataset comercial.

## Procedimiento propuesto

1. Cada owner publica su lote aprobado, versión/hash, clasificación demo y
   referencias. Conservar una sola implementación; el plan referencia su fuente.
2. Reconciliar Taxonomía → Catálogo → Pricing/Inventario; Promotions/Combos usan
   referencias publicadas compatibles. El orden no autoriza lecturas o escrituras
   SQL cross-schema. Reusar las verificaciones de DATA-VAL #17.
3. Agregar al ledger del plan el owner, schema/tablas, versión/hash, target,
   referencia de aprobación y baseline. El ledger es documental en Git, sin DDL.
4. Para la ruta runner, comprobar registry/identidad/allowlist y mantener
   shared=verify_only. La ruta MCP de cada owner conserva sus propias evidencias
   y autorizaciones; no se le exige el registry como gate adicional.
5. Ensayar solo con alcance/destino autorizados y transacción completa; dos
   ejecuciones equivalentes, conflicto de contenido rechazado y postcheck. Un
   ROLLBACK no se registra como COMMIT ni como dataset restaurado.
6. Persistencia: Marco y owners autorizan el fixture/hash y destino exactos y
   el proceso de despliegue. Esta preparación no habilita apply ni cambia la
   política de shared. Registrar resultado y verificaciones posteriores.

## Pruebas realizadas y límites

Validación reproducible desde la raíz del backend, sin variables privadas,
Gateway, broker ni conexión de base de datos:

```powershell
node scripts/seed/validate-restore-plan.mjs
node --test scripts/seed/validate-restore-plan.test.mjs scripts/seed/run.test.mjs
```

El validador comprueba el target contra el registry existente, ownership,
exclusiones, hashes SHA-256 de la preparación de Promotions y que ninguna
entrada esté habilitada para ejecución. Reporta hash del JSON normalizado del plan, versión
de preparación y cero datos persistidos. Rechaza argumentos adicionales: no
tiene modo apply ni ejecuta el runner. Si aparecen lotes aprobados, cambia el
inventario o se resuelven aprobaciones, exige revisar esta preparación; no
interpreta esos cambios como autorización automática. Un PASS valida el plan
actual, no la integridad comercial ni la restauración de datos.

- Render del runner existente para Promotions: PASS; produce la transacción
  reversible del fixture técnico y termina en ROLLBACK. **Solo render**, sin
  conexión ni ejecución SQL, y el fixture sigue excluido del restore comercial.
- Validación estática/dry-run de `restore-plan.json`: comprobar que target
  coincide con registry, verify_only sigue activo, todas las fuentes existen,
  los drafts/proyecciones están excluidos y no hay entradas ejecutables.
- Restauración comercial, ensayo DB y persistencia: NO EJECUTADOS.

Verificación local del 2026-10-16: validador PASS, 18 pruebas Node PASS
(14 del runner existente y 4 del validador), rechazo de `--apply` PASS,
formato/lint de los scripts PASS. Validaciones generales del árbol local:
81 pruebas unitarias y 154 HTTP PASS; typecheck, lint, formato y revisión de
whitespace PASS. Son resultados históricos locales. Estos archivos se retiraron
del alcance de #116 antes de su merge (`c3a6b0a`, 16/10/2026). El usuario autorizó
publicarlos después en `cueva`, sin abrir otro PR. Eso no
acredita una restauración comercial ni autoriza persistencia.

Dependencias: cada owner entrega fixtures comerciales completos/aprobados;
Marco coordina DATA-VAL #17 y autoriza cualquier ejecución/persistencia que lo
requiera. El plan no presume aprobación por silencio ni por una prueba local.

Ampliación final del mismo día: 21 pruebas Node PASS incluyendo las tres de
coherencia interna del borrador; tres hashes de evidencia verificados (baseline,
borrador y revisión de cuerpos de triggers). El plan conserva cero entradas
aprobadas. La ausencia de un lote comercial no autoriza fabricar uno ni ejecutar
la proyección técnica excluida como si fuera un restore comercial.

## Revisión adicional del alcance de #112

La preparación técnica exigida por #112 está entregada: inventario de seis
dominios, referencias al runner/manifiesto existente, ledger propuesto y dry-run
que identifica versión/target y rechaza ejecución. `restore_entries=[]` expresa
que no hay lotes elegibles en las fuentes inventariadas; no es restauración
exitosa. Revisar nuevamente el inventario cuando los owners publiquen sus lotes.

La ampliación de DATA #15 añade un generador offline y una suite PostgreSQL
descartable en `mcp/promotions/`. Su plantilla incompleta, bindings sintéticos de
prueba y preview SQL **no son lotes aprobados ni entradas del restore**. No cambia
`restore-plan.json`, sus exclusiones ni `shared=verify_only`.

La suite aislada también reproduce un bloqueo de privilegios de los triggers
de maestros de Promotions: el seed SELECT/INSERT no puede tomar los locks FOR
UPDATE de los padres. Solo afecta ese camino de carga; no invalida el dry-run
del plan #112 ni autoriza elevar privilegios. Ver el README de DATA #15 y su
evidencia nueva. El rollback aislado no es un ensayo compartido ni un restore.

Para cerrar **este issue de preparación**, faltan revisión/aceptación, PR
fusionado y cierre conforme a gobernanza. Ejecutar una restauración comercial
o poblar los seis dominios no es un criterio adicional de su alcance actual;
requiere lotes/autorizaciones específicos y se informa por separado.
