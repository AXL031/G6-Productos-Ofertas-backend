# Sincronización de cueva después del PR #117

Fecha: 16/10/2026, America/Lima. Rama: `cueva`.
Estado operativo de esta corrección: `IMPLEMENTAR_AHORA`.
Punta previa: `eac3b1e8c233817f28e9b5a4e3145116094c6bc1`, cuyo CI
38987198632 ya pasó. Master integrado en esta revisión:
`9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de` (merge de #117).
La sincronización, los cambios compartidos de dependencias y la publicación en
la misma rama fueron solicitados expresamente por el usuario.

## Preservación y alcance

Merge conservando ambas historias, sin rama nueva ni rebase. Los únicos
conflictos fueron `package.json` y `package-lock.json`.
La comparación de los 77 archivos modificados por el merge de #117 acredita
75 idénticos a master. Las únicas excepciones son los dos manifiestos de
dependencias, que añaden `amqplib` para Promotions.

Gateway, Catalog, Taxonomy, los demás servicios, `.github/`, `ops/oracle/`,
`scripts/ci/`, Dockerfile y Compose se conservan íntegros según master.
No se modifica código productivo ni pruebas de Promotions en esta revisión;
la prueba de restauración única y todo el avance de DATA se conservan.
Las únicas ediciones propias son dependencias/lockfile y documentación de
Promotions. No se ejecuta CD ni se despliega a Oracle.

Pins exactos de master en package.json y lockfile:

| Paquete | Versión |
| --- | --- |
| pg | 8.23.1 |
| drizzle-orm | 0.45.4 |
| @types/pg | 8.23.1 |
| amqplib, adicional de Promotions | 0.10.9 |

El lockfile se regeneró partiendo del de master con npm; conserva todos sus
paquetes, versiones resueltas e integridades. `package.json` es exactamente
el de master más `amqplib`. La instalación limpia pasó con Node 24.19.0 y
npm 11.6.2. Permanece el aviso preexistente de peer opcional de tsconfck
(TypeScript 5 frente al TypeScript 6 del monorepo); no se cambian dependencias
ajenas para silenciarlo. Los cambios de metadata `peer` del lockfile provienen
de la regeneración por npm.

## Pruebas del árbol sincronizado antes del commit

| Comando | Resultado ejecutado |
| --- | --- |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | PASS. |
| `npm ci --no-audit --no-fund` | PASS, 364 paquetes instalados. |
| `npm test -- apps/promotions-svc --maxWorkers=1` | PASS, 67 pruebas en 9 archivos. |
| `npm run test:e2e -- apps/promotions-svc --maxWorkers=1` | PASS, 6 HTTP. |
| `npm test -- --maxWorkers=2` | PASS, 289 pruebas en 37 archivos. |
| `npm run test:e2e -- --maxWorkers=2` | PASS, 347 pruebas; 20 omitidas en 4 archivos que necesitan configuración privada de persistencia. No se eliminan ni se presentan como ejecutadas. |
| `npm run typecheck` | PASS. |
| `npm run lint` | PASS. |
| `npm run format:check` | PASS. |
| `npm run build:all` | PASS, nueve servicios. |
| `npm run build` | PASS. |
| `npm run build:catalog-svc` | PASS. |
| `npm run build:promotions-svc` | PASS. |
| `node scripts/ci/invalid-startup.mjs` | PASS, Catalog y Taxonomy rechazan falta de configuración; no acredita arranque positivo. |
| `node apps/promotions-svc/test/startup.smoke.mjs` | PASS, configuración y gate de activación; liveness sin secretos. |
| `node apps/promotions-svc/test/coupons.isolated.smoke.mjs` | PASS, 11 escenarios con PostgreSQL 17.11/RabbitMQ 4.1 descartables, incluida segunda operación de restauración sin alterar restored_at ni liberar otro cupo. |
| `node apps/promotions-svc/test/readiness.isolated.smoke.mjs` | PASS, 7 comprobaciones reales TLS/AMQP, cero consumidores y mensajes conservados. |
| `node --test scripts/seed/run.test.mjs scripts/seed/mcp/promotions/validate-draft.test.mjs scripts/seed/mcp/promotions/prepare-batch.test.mjs scripts/seed/validate-restore-plan.test.mjs` | PASS, 31 pruebas. |
| `node scripts/seed/validate-restore-plan.mjs` | PASS, tres hashes, cero entradas aprobadas y SQL/persistencia false. |
| `node scripts/seed/mcp/promotions/validate-draft.mjs` | PASS, inactivo, no ejecutable y referencias reales pendientes. |
| `git diff --check` | PASS. |

Las pruebas locales usan exclusivamente contenedores descartables propios y
loopback; se eliminan al terminar. No conectan a Supabase ni al broker G5.
La suite de cupones distingue SHA Backend/estado del árbol de la fuente
normativa de Docs; una ejecución precommit se informa como árbol modificado.
Las comprobaciones Oracle y el smoke Marketplace con PostgreSQL/TLS de #117
permanecen intactos en el CI actualizado y deben pasar en el nuevo SHA final.

## CI final y diff revisable

El CI anterior no acredita esta sincronización. Tras confirmar/publicar el
merge, se ejecuta el workflow existente `CI` sobre `cueva` mediante
`workflow_dispatch`. El reporte de entrega debe aportar SHA, enlace a la
ejecución exitosa de ese SHA y comparación inmutable contra el master citado.
Este documento conserva resultados locales precommit; el resultado remoto se
verifica por separado en GitHub Actions. No se modifica el workflow ni se
autoriza un merge a master desde esta evidencia.

## Bloqueos conservados

- #33: `IMPLEMENTAR_PARCIAL`. Runtime y pump deshabilitados. Activar la opción
  sin adaptadores sigue rechazando el arranque. Axel/Promotions debe completar
  evidencia, elegibilidad y dispatcher propios. Ventas/Inventario y Marco deben
  aportar una fuente autorizada para reserva confirmada/snapshot durable;
  G5/owner AMQP/G7 deben acreditar identidad, ACL y conectividad para el piloto.
  Homologación G5 y despliegue siguen sin acreditarse; no se usan mocks productivos.
- #70: implementación local y pruebas separadas de integración compartida.
  `.env.local` conserva consumidor/probes false y permanece ignorado por Git.
- #15/#112: preparación y dry-run; cero persistencia demo. Poma/Vera deben
  publicar referencias/precios revisables; Marco/BD/Promotions deben resolver
  el locking del rol seed compatible con append-only y verificarlo con ese rol.
  Ejecutar/persistir requiere aprobación de Marco y owners sobre contenido/hash,
  schema/tablas y destino exactos. No se sustituyen por datos inventados ni por
  una aprobación inferida de las pruebas.

Se conservan las evidencias anteriores y los contratos/migraciones normativos
sin alterarlos. Ni el merge técnico, ni las pruebas locales, ni un CI exitoso
acreditan integración G5, homologación externa, despliegue o persistencia demo.
