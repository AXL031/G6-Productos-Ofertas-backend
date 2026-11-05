# Bloque A — preparación, integración y consultas

Rama `poma`. Base auditada: `15941b6fa3e6f00e595995abca4b328da65ff73f`.
Refs #12, #23, #45, #46, #48, #51. Corte: 2026-11-05.

## Clasificación y límites

| Alcance | Estado operativo | Evidencia / condición |
| --- | --- | --- |
| A1: reproducir ausencia histórica | IMPLEMENTAR_AHORA | `BLOCK-A1` en postgres.persistence.e2e-spec.ts |
| A1: iniciar preparación histórica faltante | BLOQUEADO_ESPECÍFICO | Marco + Poma + Vera/Taco: aprobar operación, intención e idempotencia de recuperación para identidades/precios existentes |
| A2: Pricing real | IMPLEMENTAR_AHORA | `BLOCK-A2`: módulos sin modificaciones, proceso separado, PostgreSQL TLS y broker descartables |
| A2: Inventory real → aceptación Catalog → activación | IMPLEMENTAR_PARCIAL | Productor Inventory omite AMQP userId; Catalog exige identidad autenticada; Taco debe corregir publicador y demostrar replay |
| A3: consultas / reglas / autenticación | Ya implementado, verificar suites existentes | No se cambia política comercial ni se duplica código |

El test BLOCK-A2 es una **reproducción del bloqueo**, no una aprobación del flujo completo.
Comprueba Pricing COMPLETED, resultados Inventory INITIALIZED emitidos por el proceso real,
causalidad y cuarentena de esos resultados sin identidad de transporte. Catalog permanece
PENDING y rechaza activación. Cuando Taco corrija el publicador se debe reemplazar la
expectativa del defecto por COMPLETED y completar activación simple/padre/variantes.
No se inyecta un publicador que añada userId, ni se rebajan los guards de Catalog.

## Auditoría previa

Fetch de master/poma: ambos coinciden con la base auditada; ninguna divergencia ni PR
abierta de poma al inicio. Los cambios locales anteriores en scripts/seed/mcp/catalog y
el certificado sin seguimiento se preservan y excluyen del cambio.

PR fusionadas verificadas mediante GitHub:

| PR | Merge |
| --- | --- |
| #119 | 83d75a5095ccdd9a9c06f53d9edaca4120197e37 |
| #125 | ef104d1204ea48e18676a313b2f804338a381402 |
| #162 | eeaf39ad666d7bc5a11c0b2a80d9c8c4b0016414 |
| #168 | 9f7be5e38be7b643acb956d8b3499459c146755b |
| #175 | 56e475442e5f10a5d08ffa3daf6c66e500ac5caa |
| #185 | c18a91f51c4702b0e24a166cc0eb1d9cd478e6d6 |
| #187 | d5a336614082e9e4af5af4e70a4bc2780b7b4406 |
| #191 | 9f1bed8abcab2f58677cf3cb63a40b7855e914a3 |
| #192 | 15941b6fa3e6f00e595995abca4b328da65ff73f |

La prueba Pricing opt-in existente exige además una worktree limpia en un SHA histórico;
activar solamente PRICING_TEST_CATALOG no basta para validar el candidato actual.
Las nuevas pruebas se descubren en el job E2E ordinario, sin editar workflows. El guard
existente falla en CI si faltan Docker/OpenSSL. Los SKIP locales no son PASS.

## A1 — diagnóstico y propuesta pendiente de decisión

El alta HTTP persiste BORRADOR, preparaciones PENDING y comandos Outbox en una transacción.
La carga SQL histórica no crea esos mensajes. La lectura no puede representar una
dependencia ausente con EstadoPreparacionDependencia sin inventar estado: devuelve 503.
El retry exige check PENDING e intento previo reconstruible; sin check devuelve 409
PREPARACION_NO_REINTENTABLE. No constituye una inicialización administrativa.

No se identificó una operación vigente que admita iniciar esa preparación faltante.
PATCH conserva identidad y no reejecuta alta; repetir POST colisiona por SKU. Bulk no
autoriza fabricar coordinación histórica ni COMPLETED. Se conserva la frontera.

Propuesta técnica para decisión de Marco (sin endpoint, DTO ni código nuevo):

1. Autorizar recuperación explícita sobre una selección revisada, nunca por lectura,
   arranque automático o retry. Autorización humana GESTOR_COMERCIAL no concede por sí
   sola una nueva operación: primero publicar contrato y alcance de datos.
2. Bloquear el agregado y verificar BORRADOR, identidad/SKU, maestros, modelo y ausencia
   real de preparación. En padres, Pricing solo para padre e Inventory solo por variante.
3. Exigir intención monetaria autoritativa aprobada por Pricing. No derivar un precio
   inicial de precios vigentes ni reenviar ALTA_PRODUCTO sobre un precio existente sin
   acuerdo de replay/adopción. Inventory debe confirmar tratamiento de SKU y saldos
   ya existentes sin reinicializar a cero ni duplicar ubicación.
4. Definir identidad estable de recuperación y fingerprint por dependencia. Conservar
   operación existente cuando la haya; para ausentes, creación controlada de una sola
   operación. Lock/UNIQUE aseguran un ganador; replay conserva intención.
5. Transacción local de check PENDING + Outbox; nunca COMPLETED por SQL. Cada envío tiene
   message_id, operation_id, correlation_id y causation_id trazables. Confirmar publicado
   antes de published_at; resultado debe coincidir con intento activo. Inbox deduplica.
6. Resolver adopción/rechazo con resultados reales de cada owner. COMPLETED terminal;
   REJECTED sin recuperación habilitada. Timeout de 300000 ms requiere publicación
   confirmada e idempotencia verificada; no es recuperación de una preparación ausente.
7. Probar dos solicitudes concurrentes, replay, precio/SKU existente, resultado tardío,
   fallo después de commit y antes de publicación, y ninguna modificación de saldos.

Riesgos: duplicar primer precio, perder intención original, inicializar saldos existentes,
aceptar resultados ajenos y atribuir publicación histórica sin evidencia. No se ejecuta
esta propuesta ni se activan productos compartidos.

## A2 — dependencia concreta de Inventory

- Owner: Taco, apps/inventory-svc/src/outbox/outbox-publisher.service.ts.
- Operación afectada: publicación de inventory.sku.initialization.completed/rejected.
- Comportamiento observado estáticamente: opciones publish incluyen messageId,
  correlationId, contentType, mandatory y persistent; falta userId.
- Catalog, apps/catalog-svc/src/catalog-amqp.ts, contrasta userId con producerUsers.
  Sin identidad autenticada el mensaje se considera inválido y se envía a DLQ.
- Además, Inventory emite schema_version=2 para los resultados. El envelope oficial
  AsyncAPI rc.4 admite enteros desde 1 y el payload de inicialización no cambia.
  Catalog solo admitía v1. Se corrige Catalog para aceptar v1/v2 únicamente en los
  dos resultados de inicialización Inventory ya tipados; v3, otros productores,
  causalidad/operación ausentes y payload incorrecto siguen rechazados. Se añaden
  pruebas positivas/negativas; el test entre procesos valida el sobre real v2.
  Esto no elimina el bloqueo independiente de userId ni habilita una activación.
- Desbloqueo: publicador real emite userId correspondiente a la conexión autenticada,
  RabbitMQ lo valida; pruebas entre procesos demuestran aceptación, idempotencia y
  activación sin modificar el consumidor ni añadir identidad mediante una fixture.
- Hasta la ejecución CI, la reproducción runtime nueva sigue NO EJECUTADA localmente.
- Los fixtures de Taxonomy y JWKS son explícitos: no acreditan integración Taxonomy,
  grant G7 ni autenticación con credenciales reales.

## Escenarios y evidencia reutilizada

| Escenario | Suite / caso | Tipo |
| --- | --- | --- |
| Histórico sin checks vs alta HTTP | postgres.persistence / BLOCK-A1 | HTTP + PostgreSQL TLS real en CI |
| Pricing real simple y padre, Inventory real simple y variante | postgres.persistence / BLOCK-A2 | procesos reales; reproducción de frontera bloqueada |
| Atomicidad alta, Outbox, SKU, padre sin Inventory | postgres.persistence / creates simple and variant products atomically | PostgreSQL; maestros/resultados fixtures |
| Variantes independientes, hijos no activos no bloquean | postgres.persistence / ignores unprepared draft/inactive siblings | PostgreSQL; resultados fixtures |
| Retry concurrente, stale, terminal e Inbox dedupe | postgres.persistence / admits only one manual retry | PostgreSQL; resultados fixtures |
| Sin confirm, broker desconectado/reconectado | postgres.persistence / JOINT-01 y keeps Outbox pending | broker real; productor de resultado fixture |
| PostgreSQL timeout / saturación / recuperación | postgres.persistence / PG-FAULT-01/02 | PostgreSQL real |
| Código literal, retiro, conflicto, variante no elegible | postgres.persistence / D-CAT-01..04; barcode.service | PostgreSQL + unitarias |
| Elegibilidad antes de count/paginación | postgres.persistence / D-CAT-05/06; commercial-eligibility.postgres | PostgreSQL |
| ID/slug/variantes/contexto/barcode/401/403 | catalog-http; catalog-sku-context.http; catalog-auth; catalog-security.provider | alcance de cada fixture explícito en la suite |
| Datos físicos, 422/503, estados y JWT firmado | postgres.persistence / OPEN-09-PROVIDER | HTTP + PostgreSQL + issuer de prueba |

No se presenta cobertura con resultados fabricados como integración real entre servicios.
No se añadieron tests espejo ni cambios de producción para reglas ya implementadas.
La herencia de precios sigue en Pricing; este candidato no acredita su consulta real
autenticada ni el flujo de activación posterior al bloqueo de Inventory.

## Contratos y decisiones

Consultados en master remoto de Docs: OpenAPI 0.6.0-rc.3, AsyncAPI 0.6.0-rc.4,
SPEC-003/004/010, FLOW-003/004, modelo físico, errores, kit, pruebas contractuales,
registro/matriz DEC-F, acuerdos internos H4, skuContext, matriz intermodular y G1/G2.
También AGENTS, seis guías Oracle y paquete operativo Marketplace del backend.
Fuentes y blobs en bloque-a-fuentes.json.

DEC-F-011: perfil del SKU físico; DEC-F-001/003 y decisiones internas: separar
catálogo/precio/disponibilidad, admisión y confirmación; DEC-G6-INT-01/05/13:
permisos puntuales, correlación y contexto SKU. No se amplía ninguna decisión.
D-CAT-05/06 mantiene ratificación externa pendiente. La SPEC-004/acuerdo G2 actuales
registran precedencia bilateral posterior al texto histórico de #46; no se toma
ese issue anterior como prueba del estado actual.

Fixtures SQL Inventory copiados byte a byte desde Docs master (blobs verificados en
el test); SQL Pricing reutilizado solo como infraestructura de prueba. Se ejecutan
exclusivamente dentro del PostgreSQL descartable creado por la suite. Runtime de
cada peer usa rol propio y entorno explícito, sin cargar .env ni URLs compartidas.
No se modifica otro microservicio, contratos, migraciones históricas ni workflows.

## Validación local y estado por issue

Windows / Node instalado, sin Docker. Primer intento Vitest en sandbox: FAIL EPERM
en caché temporal antes de ejecutar tests; repetición fuera del sandbox:

| Comando | Resultado |
| --- | --- |
| npm test -- apps/catalog-svc --maxWorkers=2 | PASS, 573 pruebas |
| npm run test:e2e -- apps/catalog-svc --maxWorkers=2 | 169 PASS, 114 SKIP; no acredita las dos pruebas nuevas con Docker |
| npm run typecheck | PASS |
| npm run lint | PASS |
| npm run format:check | PASS |
| npm run build:catalog-svc | PASS |
| npm run build:all | PASS |
| node --check apps/catalog-svc/test/support/preparation-peer.mjs | PASS |
| npm ci | NO EJECUTADO local; dependencias existentes; obligatorio en CI |
| npm test -- --maxWorkers=2 | 2226 PASS, 66 SKIP; 185 suites PASS y 2 SKIP |
| npm run test:e2e -- --maxWorkers=2 | FAIL: 931 PASS, 326 SKIP; una suite Bulk falla en setup por Docker ENOENT |
| git diff --check | PASS |

Bloqueo de publicación local: `apps/bulk-svc/test/bulk-postgres-outage.e2e-spec.ts:265`
ejecuta Docker de forma obligatoria en beforeAll. Error exacto:
`Docker disposable database command failed (ENOENT).`
No hay Docker instalado en esta máquina. No se elimina ni omite la prueba.
Owner: Castilla / entorno de validación. Desbloqueo: ejecutar la validación con
Docker en el runner existente. El usuario autorizó expresamente una excepción
limitada y condicionada a AGENTS §5.11 para publicar solo este Bloque A en poma
y abrir PR DRAFT: comprobar ausencia del ejecutable, conservar el FAIL local,
validar todas las comprobaciones locales disponibles y ejecutar CI completa
por SHA, incluyendo Bulk sin omisiones. No autoriza cambios de ownership,
contratos, Supabase, despliegue, merge ni marcar la PR lista.
Get-Command docker no encuentra ejecutable; la llamada real de Bulk devuelve
ENOENT antes de crear un contenedor. No hay otro fallo local de código detectado.
El run del candidato se registra en la descripción de la PR después de publicarlo.

Primer candidato publicado: fa82ef052f8404b86e500cd10a7ac64810692d4f,
PR DRAFT #194, CI 42095502089. Bulk outage ejecutó sus dos pruebas y pasó;
BLOCK-A1 pasó con PostgreSQL TLS. BLOCK-A2 falló por configuración de fixture
que combinaba DATABASE_URL y credenciales PG individuales: Inventory rechaza
expresamente esa ambigüedad. Se corrige exclusivamente el entorno de prueba de
Catalog para utilizar URL + configuración TLS, y se añade comprobación real
de salud PostgreSQL del peer antes de anunciar arranque. No se modifica Inventory
ni su parser. El FAIL original se conserva; la nueva CI validará la corrección.

Después de corregir el candidato: 34 pruebas enfocadas de mensajes PASS;
575 unitarias Catalog PASS; 169 E2E locales PASS y 114 SKIP por las mismas
dependencias/opt-in; typecheck, lint, format:check, build:catalog-svc, build:all,
node --check del peer y git diff --check PASS. La E2E general local conserva
su FAIL de Docker y no se reclasifica. La comprobación nueva de salud del peer
consulta PostgreSQL real, sin sustituir el servicio ni su repositorio.

Archivos del cambio, todos bajo Catalog:

- `apps/catalog-svc/test/postgres.persistence.e2e-spec.ts`
- `apps/catalog-svc/src/catalog-messages.ts`
- `apps/catalog-svc/src/catalog-messages.spec.ts`
- `apps/catalog-svc/test/support/disposable-catalog-broker.ts`
- `apps/catalog-svc/test/support/preparation-peer.mjs`
- `apps/catalog-svc/test/fixtures/inventory-initial.sql`
- `apps/catalog-svc/test/fixtures/inventory-operations.sql`
- `apps/catalog-svc/BLOQUE-A.md`
- `apps/catalog-svc/bloque-a-fuentes.json`

| Issue | Evidencia previa | Trabajo | Pendiente | Candidato a cierre |
| --- | --- | --- | --- | --- |
| #12 | #175 / DATA-002 | diagnóstico histórico | decisión de recuperación / aceptación dataset | No |
| #23 | #125/#162/#185 | regresión consultas existente | homologación/grants/E2E externo | No |
| #45 | #125/#185 | regresión reglas y ausencia | activación con resultados reales Inventory | No |
| #46 | #162/#185 | regresión HTTP/seguridad existente | consumidores/grants y evidencia real | No |
| #48 | #168/#187 | proceso real Pricing/Inventory y causalidad | identidad de transporte Inventory; escenarios completos | No |
| #51 | #125/#162 | prueba aislada entre peers | activación completa, E2E externo/autenticado | No |

Implementación, pruebas locales, integración entre procesos, credenciales reales,
homologación, despliegue y cierre formal son estados separados. No hay credenciales
G7 reales, nueva homologación, escritura Supabase, activación compartida ni despliegue
en esta tarea. Estado del Bloque A: PARTIAL.
