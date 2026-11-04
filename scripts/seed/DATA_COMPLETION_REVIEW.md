# Revisión de pendientes DATA propios — 16/10/2026

Owner: Axel Cueva. Rama: `cueva`. Fuentes: AGENTS.md, issues #1/#15/#112,
PR #5 fusionado y PR #116 abierto al consultar, documentación versionada de cada
entrega y Docs `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`.
No se envían mensajes, cambian issues/PR, entregan credenciales ni escriben datos
compartidos en esta revisión. Se conserva el archivo local preexistente
`reconciliation-2026-10-16.md` sin editarlo.

Actualización posterior a la separación: #116 integró solo Gateway desde
`86030ab`; su merge se confirmó en `c3a6b0a` el 16/10/2026. El usuario autorizó
publicar #33/#70/#15/#112 después en `cueva`, sin abrir otro PR. En la
revisión de correcciones se repitieron las 31 pruebas offline y ambos
validadores: PASS, referencias comerciales pendientes, borrador no ejecutable y
cero entradas de restauración aprobadas. No se ejecutó SQL ni hubo persistencia
compartida. Ver `../../apps/promotions-svc/CORRECCIONES-PENDIENTES.md` para las
correcciones independientes de backend y las dependencias vigentes.

## #15 — IMPLEMENTAR_PARCIAL

Preparación autónoma: generador de los seis maestros, plantilla sin IDs externos,
validación de referencias explícitas, precios exactos/canales/vigencias,
recomendaciones, hashes, preview reversible, pruebas negativas y PostgreSQL
aislado con migraciones oficiales verificadas. Ver
`mcp/promotions/README.md` y `test/evidence/isolated-2026-10-16.json` dentro de ese
directorio. El borrador y sus hashes históricos no se reescriben.

La prueba genera 11 filas sintéticas solo en una transacción descartable,
compara dos pasadas y termina con rollback. Su éxito con owner local no prueba
que el rol seed pueda cargar: las pruebas negativas reproducen **42501** al
tomar locks en triggers invoker. No se cambia el permiso para lograr PASS.

Pendientes precisos:

| Owner                                          | Operación                               | Condición de desbloqueo                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poma / #12                                     | Vincular campañas y recomendaciones     | IDs/productos/SKU activos publicados con fuente/versionado; revisión semántica deportiva del conjunto elegido.                                                                  |
| Vera / #13                                     | Comprobar coherencia económica          | Precios, canales y vigencias publicados para esos SKU; contraste del lote completo.                                                                                             |
| Marco + Axel/Promotions + revisión BD de López | INSERT de maestros con seed restringido | Resolver y aprobar el requisito UPDATE de los locks invoker con una solución compatible con la política append-only; demostrar el camino con rol seed sin eludir restricciones. |
| Marco + Axel owner                             | Ensayo compartido                       | Alcance/tablas/destino autorizados, referencias finales, SQL/hash exactos y bloqueo de permisos resuelto; revisar triggers actuales y transacción completa.                     |
| Marco + Axel owner                             | Persistencia                            | Aprobación explícita del contenido/hash y destino exactos; repetición/conflictos y postcheck comprobados.                                                                       |

No se solicita homologación G1/G4/G5/G7 para estos datos internos. Integración
autenticada histórica propia es solo lectura; no equivale a carga comercial.

## #112 — preparación técnica entregada, cierre pendiente

| Criterio vigente                                    | Evidencia                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Inventario y solo datos demo elegibles              | Seis dominios en `restore-plan.json`; cero lotes aprobados y exclusión de borrador/proyección técnica.   |
| Reusar mecanismo y no duplicar seeds                | Referencias explícitas a runner, registry y dataset existentes.                                          |
| Ledger/versionado y pre/postchecks                  | `ledger_proposal` y procedimiento de `RESTORE_PLAN.md`; sin DDL ni ejecuciones registradas.              |
| Dry-run con versión/target y persistencia bloqueada | `validate-restore-plan.mjs`, pruebas negativas de target/activación/fuentes/hash; sin modo apply ni SQL. |

Revisión/aceptación de Marco, merge de la entrega y cierre siguen pendientes.
Un restore comercial no ejecutado se informa como tal, sin convertirlo en un
requisito nuevo para cerrar este alcance de preparación.

## #1 — infraestructura entregada, evidencias de cierre pendientes

`evidence.md` conserva auditoría, seis logins/ocho schemas con psql/SSL,
verificación reversible y CI históricos. PR #5 está fusionado; su descripción
histórica no refleja todos los resultados posteriores. La prueba local actual
del runner no vuelve a autenticar esas cuentas ni revalida el Supabase compartido.

Para cerrar: confirmar entrega privada y cambio de contraseña; aprobación del
manifiesto por sus owners; revisión BD/integración de López/Marco. No se exige
que Axel cree o ejecute las cargas ajenas. El hallazgo de locks de #15 se
registra por separado: la prueba técnica stock_projection de #1 no comprobaba
INSERT de todos los agregados maestros.

| Destinatario | Schemas              | Confirmación de entrega/cambio disponible en esta revisión |
| ------------ | -------------------- | ---------------------------------------------------------- |
| Axel         | promotions           | Cambio no acreditado aquí.                                 |
| López        | taxonomy             | Sin confirmación nueva.                                    |
| Poma         | catalog              | Sin confirmación nueva.                                    |
| Taco         | inventory            | Sin confirmación nueva.                                    |
| Vera         | pricing, price_audit | Sin confirmación nueva.                                    |
| Castilla     | combos, bulk         | Sin confirmación nueva.                                    |

No inventar confirmaciones ni leer archivos de entrega para llenar la tabla.
Registrar después solo fecha/confirmación, nunca contraseñas ni rutas privadas.

## Continuidad de backend

#71 exige que #70 esté probado y fusionado antes de iniciar implementación.
#72 depende de #71; #75 de #74; #76 de #75. El PR #116 seguía sin merge al corte.
Esta tarea avanza DATA, sin iniciar esos bloques ni suponer una excepción nueva
de alcance para publicar estos cambios en ese PR.

## Validación real de esta ampliación

Ejecutada el 16/10/2026. Cambios locales sin commit/push; los resultados no
corresponden a un CI remoto ni a una revisión/aceptación de Marco.

| Comando                                                                                                                                                                                    | Resultado                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test scripts/seed/run.test.mjs scripts/seed/mcp/promotions/validate-draft.test.mjs scripts/seed/mcp/promotions/prepare-batch.test.mjs scripts/seed/validate-restore-plan.test.mjs` | PASS: 31 pruebas, incluidas 10 nuevas del generador/CLI.                                                                                                         |
| `node scripts/seed/mcp/promotions/test/isolated.mjs`                                                                                                                                       | PASS de las comprobaciones locales con PostgreSQL 17.11; bloqueo seed 42501 reproducido como resultado esperado, no corregido. Contenedor eliminado al terminar. |
| `node scripts/seed/mcp/promotions/validate-draft.mjs`                                                                                                                                      | PASS: borrador no ejecutable y referencias pendientes.                                                                                                           |
| `node scripts/seed/validate-restore-plan.mjs`                                                                                                                                              | PASS: tres hashes históricos y cero entradas aprobadas; sin SQL/persistencia.                                                                                    |
| `npm test -- apps/promotions-svc --maxWorkers=1`                                                                                                                                           | PASS: 58 pruebas enfocadas.                                                                                                                                      |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1`                                                                                                                                   | PASS: 5 HTTP enfocadas.                                                                                                                                          |
| `npm test -- --maxWorkers=1`                                                                                                                                                               | PASS: 122 unitarias generales.                                                                                                                                   |
| `npm run test:e2e -- --maxWorkers=1`                                                                                                                                                       | PASS: 311 HTTP generales.                                                                                                                                        |
| `npm run typecheck`                                                                                                                                                                        | PASS.                                                                                                                                                            |
| `npm run lint`                                                                                                                                                                             | PASS.                                                                                                                                                            |
| `npm run format:check`                                                                                                                                                                     | PASS.                                                                                                                                                            |

La suite PostgreSQL y las pruebas Vitest se ejecutaron con acceso a procesos y
loopback fuera del sandbox de Windows. El generador y los tests DATA offline
pasaron dentro del sandbox. No se cambió configuración global ni se instaló
dependencia. Build adicional no requerido para estos scripts/documentación;
no cambian los ejecutables NestJS. No se declara integración autenticada nueva,
homologación ni despliegue.
