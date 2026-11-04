# Revisión de Promotions después del Gateway #116

Esta es la evidencia histórica de la primera sincronización y del CI
38987198632, SHA `eac3b1e8c233817f28e9b5a4e3145116094c6bc1`.
La revisión posterior al merge de #117 se registra por separado en
[`REVISION-POST-117-2026-10-16.md`](REVISION-POST-117-2026-10-16.md).

Fecha: 16/10/2026, America/Lima. Rama única: `cueva`.
Base anterior de cueva: `77b4ce51f441b1c49e07f88ecae3619d2479d598`.
Master integrado: `5bb832b103f9cca4d0967fecde26c1ebccd05944`.
La sincronización y los cambios de dependencias compartidas fueron solicitados
expresamente por el usuario. Se preservan ambas historias mediante merge,
sin rebase, sobrescritura forzada ni rama nueva. El Gateway aprobado y los
servicios ajenos coinciden con master; no se implementa autenticación.

## Dependencias y contrato

`package.json` conserva todas las dependencias/scripts de master y añade solo
`amqplib 0.10.9`. Se mantienen `pg ^8.23.1`, `drizzle-orm ^0.45.4` y
`@types/pg ^8.23.1`. El lockfile se regeneró partiendo de master; no elimina
paquetes ni cambia versiones resueltas de sus entradas existentes. Sus cambios
adicionales de metadata `peer` proceden de npm. `npm ci` pasó con Node 24.19.0;
el Node 24.11.1 instalado en el sistema no cumple engines y no se usa para
las validaciones finales. Permanece el aviso preexistente del peer opcional
TypeScript 5 de tsconfck frente a TypeScript 6 del monorepo.

Fuentes contrastadas: AsyncAPI 0.6.0-rc.2 (blob actual
`a5552e51c651d1eabfcd6cbb9607abf8ab0573e9`) y OpenAPI 0.6.0-rc.1 (blob
`f64bfe9a097b2a0f74c2600988305443d92f640e`), SPEC-005, Arquitectura §17,
modelo físico de Promotions y DEC-F-007/008/009/012. Registro DEC-F y matrices
consultados en Docs `942bf7322eb388fe5b0fcc9c5a565152e1099139`.
Migraciones oficiales 0001–0004 de Docs
`c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, sin alteraciones.
No se cambia el contrato candidato ni se declara homologación externa.

## Estado por issue

| Issue / estado operativo | Implementado y probado localmente | Pendiente interno/formal | Dependencia externa específica |
| --- | --- | --- | --- |
| #33 — IMPLEMENTAR_PARCIAL | Validación contractual, Inbox/receipts/Outbox, locks, ACK después de commit, confirms, pump y restauración idempotente. Smoke PostgreSQL/RabbitMQ: 11 escenarios PASS. | Adaptadores autorizados de evidencia, elegibilidad propia y dispatcher completo. Consumidor y pump deshabilitados; `true` rechaza el arranque antes de consumir/publicar. Revisión, integración y cierre pendientes. | Ventas/Inventario + Marco: fuente autorizada para verificar reserva confirmada y snapshot durable; G5/owner AMQP/G7: identidad, ACL y conectividad verificadas para el piloto. La homologación G5 requiere evidencia externa propia. |
| #70 — IMPLEMENTAR_AHORA | Configuración fail-closed, liveness, logs sin secretos y probes PostgreSQL TLS/AMQP pasivos. Smoke real: 7 comprobaciones PASS; arranque compilado protegido PASS. | Revisión/aceptación, merge y cierre. Readiness HTTP pertenece al bloque posterior #76; no se agregan rutas. La configuración privada de este equipo tiene tres campos aún vacíos. | Ninguna para el alcance interno de #70. Para comprobar conexión compartida del equipo faltan contraseña propia, CA autorizado y destino AMQP privado, aportados por sus responsables. |
| #15 — IMPLEMENTAR_PARCIAL | Diseño inactivo y generador offline de seis maestros; validadores y ensayo PostgreSQL descartable PASS con rollback e idempotencia. Se revalidó el bloqueo del rol seed, separado del ensayo con owner local. | Bindings reales, revisión comercial, ensayo autorizado y aprobación del lote. No hay carga comercial. | Poma/Catálogo #12: IDs/SKU publicados y estados; Vera/Pricing #13: precios/canales/vigencias publicados; Marco/BD/Promotions con revisión López: solución aprobada de privilegios/locking para triggers FOR UPDATE, compatible con append-only y verificada como seed. Persistencia: Marco/owner aprueban SQL/hash y destino exactos. |
| #112 — IMPLEMENTAR_PARCIAL | Plan/ledger y dry-run reutilizan INFRA #1; tres hashes válidos, cero entradas aprobadas, SQL y persistencia deshabilitados. | Reconciliar candidatos publicados por owners, revisar/aceptar el plan y formalizar merge/cierre. Master ahora aporta un candidato taxonomy; no se presume aprobación para restore. | Cada owner DATA entrega fixture aprobado/versionado; Marco/DATA-VAL #17 valida referencias. Ejecución compartida solo tras aprobación de contenido/hash, schemas/tablas y destino exactos por Marco y owners. |

El bloqueo de una frontera de #33 o de carga de #15 no paraliza el trabajo
interno de Promotions. Ninguno de estos resultados acredita integración
autenticada compartida, homologación externa, despliegue ni cierre de issues.
No se hicieron consultas ni escrituras a Supabase ni al broker compartido.
Los providers sintéticos existen únicamente en pruebas descartables.

## Regresión de restauración

El smoke consume un cupón con límite global 1, restaura el uso y permite un
solo consumo de reemplazo. Luego envía otra operación de restauración sobre
el consumo original con una fecha distinta, y reentrega ambos comandos.
Verifica que el primer `restored_at`, `updated_at` y la historia no cambien,
que otro pedido siga recibiendo `COUPON_GLOBAL_LIMIT` y que queden exactamente
dos usos: uno restituido y uno activo. No hizo falta modificar la implementación
productiva: su UPDATE ya exige `restored_at IS NULL`.

## Validación del árbol sincronizado antes del commit

| Comando | Resultado real |
| --- | --- |
| `npm ci --no-audit --no-fund` | PASS, 364 paquetes; aviso peer opcional preexistente. |
| `npm test -- apps/promotions-svc --maxWorkers=1` | PASS, 67 pruebas. |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1` | PASS, 6 pruebas HTTP. |
| `npm test -- --maxWorkers=2` | PASS, 192 pruebas en 29 archivos. |
| `npm run test:e2e -- --maxWorkers=2` | PASS, 340 pruebas; 13 omitidas en 2 archivos de persistencia que requieren entorno PostgreSQL propio. Las omisiones no acreditan integración. |
| `npm run typecheck` | PASS. |
| `npm run lint` | PASS. |
| `npm run format:check` | PASS. |
| `npm run build` | PASS. |
| `npm run build:catalog-svc` | PASS. |
| `npm run build:all` | PASS, los nueve servicios. |
| `npm run build:promotions-svc` | PASS. |
| `node apps/promotions-svc/test/startup.smoke.mjs` | PASS, configuración inválida y activación sin adaptadores rechazan arranque; liveness válido sin secretos. |
| `node apps/promotions-svc/test/coupons.isolated.smoke.mjs` | PASS, 11 escenarios con PostgreSQL 17.11 y RabbitMQ 4.1 descartables. |
| `node apps/promotions-svc/test/readiness.isolated.smoke.mjs` | PASS, 7 comprobaciones con TLS y AMQP reales; cero consumidores y mensajes conservados. |
| `node --test scripts/seed/run.test.mjs scripts/seed/mcp/promotions/validate-draft.test.mjs scripts/seed/mcp/promotions/prepare-batch.test.mjs scripts/seed/validate-restore-plan.test.mjs` | PASS, 31 pruebas. |
| `node scripts/seed/mcp/promotions/validate-draft.mjs` | PASS, borrador inactivo no ejecutable; referencias pendientes. |
| `node scripts/seed/validate-restore-plan.mjs` | PASS, dry-run, tres hashes, cero entradas aprobadas, SQL/persistencia false. |
| `node scripts/seed/mcp/promotions/test/isolated.mjs` | PASS; seis maestros, repetición, constraints y rollback. Rol seed bloqueado por privilegio de lock; no se amplían grants. |
| `git diff --check` | PASS. |

El primer intento de Vitest dentro del sandbox falló antes de ejecutar pruebas
por EPERM al renombrar su caché temporal. La repetición fuera de esa restricción
pasó; no se alteraron pruebas para resolver el fallo del entorno.
Docker Desktop se inició para estas pruebas, con puertos solo en loopback y
contenedores propios eliminados al terminar. `.env.local` está ignorado y no
se usa como evidencia de conexión compartida; conserva el runtime desactivado.

## CI del SHA final

Este documento registra pruebas locales previas al commit; no afirma que sean
CI. Tras publicar el commit final de `cueva`, ejecutar el workflow existente
`CI` mediante `workflow_dispatch` sobre esa rama, sin crear otro PR ni modificar
workflows. Los comentarios de evidencias en #33, #70, #15 y #112 deben enlazar
el SHA exacto y la ejecución con su conclusión real. Una ejecución de otro SHA
no satisface esta revisión. No se autoriza merge a master con este documento.
